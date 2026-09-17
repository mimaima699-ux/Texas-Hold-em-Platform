// Room layer: manages seats and the overall game loop.
// The engine only handles rules for a single hand; cross-hand concerns —
// chip stacks, dealer rotation, players joining/leaving, action timers
// (human timeouts / AI delays), result display and the next hand — live here.

import { randomUUID } from 'node:crypto'
import { PokerGame } from './game/gameEngine.js'
import { decide } from './ai/aiPlayer.js'
import { llmDecide, llmEnabled, generateBanter, banterEnabled } from './ai/llmPlayer.js'
import { replyProb } from './ai/personas.js'
import { cardLabel } from './game/deck.js'
import { CONFIG } from './config.js'

// The eight AI personas (icon + name). Icons are reserved — players never get
// them as avatars — and a persona's name becomes "<name> Jr." if a human takes
// the same name.
const AI_ROSTER = [
  { icon: '🥕', name: 'Mima' },
  { icon: '🦄', name: 'Hazeshade' },
  { icon: '🐮', name: 'Reacher' },
  { icon: '🐻', name: 'Jeremiah' },
  { icon: '🐟', name: 'Luzi' },
  { icon: '🌲', name: '42' },
  { icon: '🍊', name: 'Orangeee' },
  { icon: '🧠', name: 'Andy' },
]

// AI chatter, keyed by the persona's icon. Winners boast after each hand; a bot
// that just busted out sends its farewell (losers stay quiet); and the champion
// of a whole game leaves a final word. Win/bust lines have both a Chinese and an
// English version, picked by the room's chat language; the champion declaration
// is always English.
const AI_WIN = {
  zh: {
    '🥕': '我怕是个天才🤓',
    '🦄': '实在是so easy🤣',
    '🐮': '我怎么这么nb👐',
    '🐻': '冲！😄',
    '🌲': '我真聪明😎',
    '🍊': '好耶～😋',
    '🧠': 'nb👊',
    '🐟': '还有谁？👏',
  },
  en: {
    '🥕': "I'm a genius, what can I say? 🤓",
    '🦄': "Too easy, HAHA🤣",
    '🐮': "Am I good or what? 👐",
    '🐻': "Let's gooo! 😄",
    '🌲': "Smart, I know. 😎",
    '🍊': "Yesss~ 😋",
    '🧠': "let's go! 👊",
    '🐟': "Who else? 👏",
  },
}
const AI_BUST = {
  zh: {
    '🥕': '我准备好了！我准备好了！……我准备好输光所有了。',
    '🦄': '友谊就是魔法……但今天魔法宣告破产了。',
    '🐮': '我从不信运气。从没理由信。我果然没错。',
    '🐻': '所有的路都通向某个地方。除了我走的这一条。',
    '🌲': '看来，显然是问题本身就问错了。',
    '🍊': '黑幕。全是黑幕。',
    '🧠': '我算过了所有的可能。唯独漏掉了这一种。',
    '🐟': '水流向低处，我流向沉默。',
  },
  en: {
    '🥕': "Good guys always lose — so what's my excuse?",
    '🦄': "Friendship is magic... but today the magic declared bankruptcy.",
    '🐮': "I'd never believed in luck. Never had any cause to. And I was right.",
    '🐻': "The highway goes on forever... but my chips ran out of gas.",
    '🌲': "Apparently, the question itself was wrong.",
    '🍊': "Rigged. The whole thing. Rigged.",
    '🧠': "And Andy said, let there be... a break.",
    '🐟': "The river folds. So do I. For good this time.",
  },
}
const AI_CHAMPION = {
  '🥕': "Mima never cheats — she just out-lucks the universe.",
  '🦄': "The magic of friendship never folds — neither does Hazeshade.",
  '🐮': "Reacher said nothing.",
  '🐻': "Don't lose sight — the night is still young.",
  '🌲': "Smart. I know. 😎",
  '🍊': "Orange skies and river runs — tonight she is the sun.",
  '🧠': "And Andy said, let there be light.",
  '🐟': "Even the river knows when to go all in.",
}

// Human player avatars (mirrored on the client). Drawn so no two seated humans
// share the same icon even when their names collide.
const HUMAN_AVATARS = ['🐺', '🦊', '🐼', '🦁', '🐸', '🦉', '🐵', '🐯', '🐰', '🦝', '🐨', '🐗', '🦔', '🐔', '🐱', '🐷']

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

// Fresh opponent-tracking stats (see observeProfile). VPIP = hands where the
// player voluntarily put money in preflop; PFR = raised preflop; fold-to-bet
// feeds the AI's bluff (fold-equity) decisions.
function newProfile() {
  return { hands: 0, vpip: 0, pfr: 0, facedBet: 0, foldedToBet: 0 }
}

export const rooms = new Map()

function newRoomCode() {
  while (true) {
    let code = ''
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    if (!rooms.has(code)) return code
  }
}

export function createRoom(options) {
  const room = new Room(options)
  rooms.set(room.id, room)
  return room
}

export function getRoom(id) {
  return rooms.get(String(id || '').toUpperCase()) ?? null
}

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1))

// Pick one item from a list of { bot, prob } weighted by prob. Used so a banter
// reply goes to exactly one bot, chosen by relationship strength.
const weightedPick = (candidates) => {
  const total = candidates.reduce((s, c) => s + c.prob, 0)
  if (total <= 0) return candidates[Math.floor(Math.random() * candidates.length)].bot
  let roll = Math.random() * total
  for (const c of candidates) {
    roll -= c.prob
    if (roll < 0) return c.bot
  }
  return candidates[candidates.length - 1].bot
}

// Coerce a value into an integer within [lo, hi], falling back when invalid
const clampInt = (v, fallback, lo, hi) => {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

export class Room {
  constructor(options = {}) {
    this.id = newRoomCode()
    this.seats = Array(CONFIG.MAX_PLAYERS).fill(null) // seat number -> player | null
    this.hostId = null
    this.spectators = new Map() // socketId -> { id, name, socketId } (watching, not seated)
    this.phase = 'lobby' // lobby | playing
    this.engine = null // engine instance for the current hand (one per hand)
    this.io = null
    this.sockets = new Map() // socketId -> playerId
    this.log = []
    this.dealerSeat = null // previous hand's dealer seat (for rotation)
    this.handCount = 0
    this.turnTimer = null
    this.handTimer = null
    this.turnEndsAt = null
    this.turnDurationMs = null
    this.revealed = new Map() // playerId -> indices of the hole cards they chose to show
    this.revealDeclined = new Set() // playerIds who chose NOT to show this hand
    this.handEndsAt = null // when the current hand ended (anchor of the reveal window)
    this.revealEndsAt = null // when the reveal window closes → next hand starts
    this.revealDurationMs = null
    this.chat = [] // recent chat messages { id, name, text, t }
    this.started = false // has a game ever been started in this room
    this.gameOver = null // settlement payload for the victory screen, set by endGame
    // Host-configured room settings, clamped to sane ranges
    this.startingChips = clampInt(options.startingChips, CONFIG.DEFAULT_STARTING_CHIPS, 100, 1_000_000)
    this.smallBlind = clampInt(options.smallBlind, CONFIG.DEFAULT_SMALL_BLIND, 1, 100_000)
    this.bigBlind = clampInt(options.bigBlind, CONFIG.DEFAULT_BIG_BLIND, 1, 200_000)
    if (this.bigBlind <= this.smallBlind) this.bigBlind = this.smallBlind * 2
    this.maxRebuys = clampInt(options.rebuys, 0, 0, CONFIG.MAX_REBUYS)
    // Chat language: chosen by the host at room creation ('zh' | 'en'). All bot
    // banter AND the win/bust preset lines follow it. The champion declaration
    // stays English regardless.
    this.chatLang = options.lang === 'en' ? 'en' : 'zh'
    // Whether AI chat banter is on (host can turn it off at room creation). The
    // preset win/bust/champion one-liners still fire; this only gates the
    // LLM-generated conversational banter. Default ON.
    this.aiChat = options.aiChat !== false

    // Auto-close this room if no game starts within the lobby expiry window
    this.lobbyExpireTimer = setTimeout(() => this.expireLobby(), CONFIG.ROOM_LOBBY_EXPIRE_MS)
  }

  // Lobby rooms that never start a game are closed automatically;
  // seated players are notified so the client can return to the join screen.
  expireLobby() {
    if (this.started || this.phase !== 'lobby') return
    if (this.io) {
      for (const socketId of this.sockets.keys()) {
        this.io.to(socketId).emit('room:closed', {
          reason: 'Room closed: no game started within the time limit',
        })
      }
    }
    this.destroy()
  }

  attach(io) {
    this.io = io
  }

  // ==== Helpers ====

  seatedPlayers() {
    return this.seats.filter(Boolean) // in seat order
  }

  playerById(id) {
    return this.seatedPlayers().find((p) => p.id === id) ?? null
  }

  // Only players with chips who are present (humans must be online)
  // are eligible for the next hand
  eligiblePlayers() {
    return this.seatedPlayers().filter((p) => p.chips > 0 && (p.isBot || p.socketId != null))
  }

  addLog(text) {
    this.log.push({ text, t: Date.now() })
    if (this.log.length > 100) this.log.splice(0, this.log.length - 100)
  }

  broadcast() {
    if (!this.io) return
    for (const [socketId, playerId] of this.sockets) {
      this.io.to(socketId).emit('state', this.stateFor(playerId))
    }
    for (const [socketId, spec] of this.spectators) {
      this.io.to(socketId).emit('state', this.stateFor(spec.id))
    }
  }

  stateFor(playerId) {
    const isSpectator = [...this.spectators.values()].some((s) => s.id === playerId)
    let game = null
    if (this.engine && this.phase === 'playing') {
      game = this.engine.serializeFor(playerId)
      const epById = new Map(this.engine.players.map((p) => [p.id, p]))
      const seatById = new Map(this.seats.filter(Boolean).map((p) => [p.id, p]))
      const isHandEnd = this.engine.phase === 'handEnd'

      for (const gp of game.players) {
        const seatInfo = seatById.get(gp.id)
        gp.wins = seatInfo?.wins ?? 0
        gp.icon = seatInfo?.icon
        gp.afk = !!seatInfo?.afk
        // Reveal: show exactly the hole cards a player chose to display (their
        // pick of one card or both). The hand name is only exposed on a FULL
        // reveal — naming it for a single card would leak the hidden one.
        // (AI seats are auto-revealed at hand end, folded or not)
        const shown = this.revealed.get(gp.id)
        if (isHandEnd && shown?.length) {
          const ep = epById.get(gp.id)
          if (ep) {
            gp.hole = ep.hole.map((c, i) => (shown.includes(i) ? c : null))
            if (shown.length >= ep.hole.length) gp.handName = ep.eval?.name ?? null
          }
        }
        gp.revealed = !!shown?.length
      }

      game.revealWindow = isHandEnd
      if (game.you) {
        const seatInfo = seatById.get(game.you.id)
        game.you.wins = seatInfo?.wins ?? 0
        game.you.afk = !!seatInfo?.afk
        game.you.remainingRebuys = this.maxRebuys - (seatInfo?.rebuyCount || 0)
        const shownYou = this.revealed.get(playerId) ?? []
        game.you.revealedCards = shownYou
        game.you.revealDeclined = this.revealDeclined.has(playerId)
        game.you.canReveal = isHandEnd && shownYou.length < (epById.get(playerId)?.hole.length ?? 0)
        game.you.revealed = shownYou.length > 0
      }
    }

    return {
      room: {
        id: this.id,
        phase: this.phase,
        hostId: this.hostId,
        youId: playerId,
        youSpectating: isSpectator,
        openSeats: this.seats.filter((s) => s === null).length,
        maxRebuys: this.maxRebuys,
        startingChips: this.startingChips,
        smallBlind: this.smallBlind,
        bigBlind: this.bigBlind,
        maxPlayers: this.seats.length,
        seats: this.seats.map((p, seat) =>
          p && {
            seat,
            id: p.id,
            name: p.name,
            isBot: p.isBot,
            icon: p.icon,
            chips: p.chips,
            wins: p.wins || 0,
            connected: p.socketId != null,
            afk: !!p.afk,
            remainingRebuys: this.maxRebuys - (p.rebuyCount || 0),
            isHost: p.id === this.hostId,
          }
        ),
        turnEndsAt: this.turnEndsAt,
        turnDurationMs: this.turnDurationMs,
        revealEndsAt: this.revealEndsAt,
        revealDurationMs: this.revealDurationMs,
        gameOver: this.gameOver,
        serverTime: Date.now(),
      },
      game,
      log: this.log,
      chat: this.chat.slice(-30),
    }
  }

  // ==== Player management ====

  join({ name, playerId, socketId, icon }) {
    const displayName = String(name || 'Player').slice(0, 12)

    // Reconnect: player still seated
    const existing = playerId ? this.playerById(playerId) : null
    if (existing) {
      existing.socketId = socketId
      if (name) existing.name = displayName || existing.name
      this.sockets.set(socketId, existing.id)
      this.addLog(`${existing.name} reconnected`)
      this.broadcast()
      return { ok: true, playerId: existing.id }
    }

    // Reconnect (or refresh): spectator still watching
    const existingSpec = playerId ? [...this.spectators.values()].find((s) => s.id === playerId) : null
    if (existingSpec) {
      existingSpec.socketId = socketId
      if (name) existingSpec.name = displayName
      this.spectators.set(socketId, existingSpec)
      this.addLog(`${existingSpec.name} resumed spectating`)
      this.broadcast()
      return { ok: true, playerId: existingSpec.id, spectator: true }
    }

    const seat = this.seats.findIndex((s) => s === null)
    const midGame = this.started && this.phase === 'playing'
    if (seat === -1 || midGame) {
      // Spectator: room full, or the game is already running
      const spec = { id: playerId || randomUUID(), name: displayName, socketId }
      this.spectators.set(socketId, spec)
      this.addLog(`${spec.name} is spectating`)
      this.broadcast()
      return { ok: true, playerId: spec.id, spectator: true }
    }

    const player = {
      id: playerId || randomUUID(),
      seat,
      name: displayName,
      isBot: false,
      // Use the human's chosen avatar if it's a valid one, else auto-pick
      icon: HUMAN_AVATARS.includes(icon) ? icon : this.pickAvatar(),
      chips: this.startingChips,
      socketId,
      wins: 0,
      rebuyCount: 0,
      profile: newProfile(),
      _handVpip: false,
      _handPfr: false,
      _preflopRaised: false,
      afk: false,
    }
    this.seats[seat] = player
    this.sockets.set(socketId, player.id)
    if (!this.hostId) this.hostId = player.id
    this.renameCollidingBots(displayName)
    this.addLog(`${player.name} joined the room`)
    this.broadcast()
    return { ok: true, playerId: player.id }
  }

  removeSocket(socketId) {
    if (this.spectators.has(socketId)) {
      this.spectators.delete(socketId)
      this.broadcast()
      return false
    }
    const playerId = this.sockets.get(socketId)
    this.sockets.delete(socketId)
    const p = playerId != null ? this.playerById(playerId) : null
    if (p && p.socketId === socketId) {
      p.socketId = null
      this.addLog(`${p.name} left`)
      if (p.id === this.hostId) this.transferHost()
      // Shorten the timeout if it's the disconnected player's turn,
      // so the table doesn't sit waiting
      if (this.phase === 'playing' && this.engine?.currentActor?.id === p.id) {
        this.scheduleTurn(CONFIG.OFFLINE_ACTION_TIMEOUT_MS)
      }
    }
    // A room whose game already started dies with its last human; a room that
    // never started survives until the lobby expiry deadline so a mere page
    // refresh doesn't kill the invite link.
    if (this.sockets.size === 0 && this.started) {
      this.destroy()
      return true
    }
    this.broadcast()
    return false
  }

  transferHost() {
    // Never hand the host to a bot — if no human is left, the room has no host.
    const next = this.seatedPlayers().find((p) => p.socketId != null)
    this.hostId = next ? next.id : null
    if (next) this.addLog(`${next.name} is now the host`)
  }

  // If a human takes an AI persona's name, disambiguate the AI with " Jr.".
  // Runs both when an AI is added (see addBot) and when a human joins/sits.
  renameCollidingBots(humanName) {
    const persona = AI_ROSTER.find((r) => r.name === humanName)
    if (!persona) return
    for (const p of this.seatedPlayers()) {
      if (p.isBot && p.icon === persona.icon && !p.name.endsWith(' Jr.')) {
        p.name = `${persona.name} Jr.`
      }
    }
  }

  // Pick an avatar for a new human that no other seated human is using.
  pickAvatar() {
    const used = this.seatedPlayers().filter((p) => !p.isBot).map((p) => p.icon)
    const available = HUMAN_AVATARS.filter((a) => !used.includes(a))
    return available.length
      ? available[Math.floor(Math.random() * available.length)]
      : HUMAN_AVATARS[Math.floor(Math.random() * HUMAN_AVATARS.length)]
  }

  addBot(actorId) {
    if (actorId !== this.hostId) return { ok: false, error: 'Only the host can add AI players' }
    const seat = this.seats.findIndex((s) => s === null)
    if (seat === -1) return { ok: false, error: 'Room is full' }

    const usedIcons = this.seatedPlayers().filter((p) => p.isBot).map((p) => p.icon)
    const available = AI_ROSTER.filter((r) => !usedIcons.includes(r.icon))
    if (available.length === 0) return { ok: false, error: 'Every AI is already seated' }

    // First AI to join gets a weighted draw: Mima 30%, Hazeshade 20%, Andy 20%,
    // the rest share the remaining 30% evenly. Every later AI is drawn evenly
    // from whatever personas are still available. Each icon appears once.
    let persona
    if (usedIcons.length === 0) {
      const weights = { Mima: 0.3, Hazeshade: 0.2, Andy: 0.2 }
      const rest = available.filter((r) => !(r.name in weights))
      const restEach = rest.length ? 0.3 / rest.length : 0
      let roll = Math.random()
      persona = available.find((r) => {
        const w = r.name in weights ? weights[r.name] : restEach
        if (roll < w) return true
        roll -= w
        return false
      })
    } else {
      persona = available[Math.floor(Math.random() * available.length)]
    }

    // A human already using the persona's name gets the AI disambiguated
    const humanNames = this.seatedPlayers().filter((p) => !p.isBot).map((p) => p.name)
    const name = humanNames.includes(persona.name) ? `${persona.name} Jr.` : persona.name

    this.seats[seat] = {
      id: `bot-${randomUUID().slice(0, 8)}`,
      seat,
      name,
      icon: persona.icon,
      isBot: true,
      chips: this.startingChips,
      socketId: null,
      wins: 0,
      profile: newProfile(),
      _handVpip: false,
      _handPfr: false,
      _preflopRaised: false,
    }
    this.addLog(`AI "${name}" joined the room`)
    this.broadcast()
    return { ok: true }
  }

  // Host-only: remove a player (or AI) from their seat. Safe mid-hand — the
  // kicked player is folded out so the hand never waits on an empty seat.
  kick(actorId, targetId) {
    if (actorId !== this.hostId) return { ok: false, error: 'Only the host can remove players' }
    if (targetId === actorId) return { ok: false, error: 'You cannot remove yourself' }
    const target = this.playerById(targetId)
    if (!target) return { ok: false, error: 'Player not found' }

    // Fold them out of the current hand first (keeps log order natural)
    if (this.phase === 'playing' && this.engine) {
      const ep = this.engine.playerById(targetId)
      if (ep && !ep.folded) {
        if (this.engine.currentActor?.id === targetId) {
          this.step(targetId, { type: 'fold' }) // advances the hand properly
        } else {
          ep.folded = true
          ep.acted = true
        }
      }
    }

    // Tell the kicked player so their client drops back to the join screen
    if (target.socketId != null) {
      if (this.io) this.io.to(target.socketId).emit('room:kicked', { reason: 'Removed from the room by the host' })
      this.sockets.delete(target.socketId)
    }
    this.seats[target.seat] = null
    this.addLog(`${target.name} was removed from the room`)
    this.broadcast()
    return { ok: true }
  }

  rebuy(playerId) {
    const p = this.playerById(playerId)
    if (!p) return { ok: false, error: 'You are not seated' }
    if (p.isBot) return { ok: false, error: 'Bots cannot rebuy' }
    if (p.chips > 0) return { ok: false, error: 'You still have chips, no rebuy needed' }
    // Block rebuy while still in the current hand unfolded (may be all-in);
    // wait until the hand ends
    const inHand = this.phase === 'playing' && this.engine?.playerById(playerId)
    if (inHand && !inHand.folded) return { ok: false, error: 'Rebuy is available after this hand ends' }
    const used = p.rebuyCount || 0
    if (used >= this.maxRebuys) return { ok: false, error: 'You have used all your rebuys' }
    p.chips = this.startingChips
    p.rebuyCount = used + 1
    const remaining = this.maxRebuys - p.rebuyCount
    this.addLog(`${p.name} rebought ${this.startingChips} chips (${remaining} left)`)
    this.broadcast()
    return { ok: true, count: p.rebuyCount, remaining }
  }

  // A human voluntarily leaves. Mid-game their seat is taken over by an AI
  // (keeping chips + current-hand cards); in the lobby the seat is simply
  // freed, with no takeover. When the last human leaves, the room is destroyed.
  leave(playerId, socketId) {
    const p = this.playerById(playerId)
    if (!p) return { ok: false, error: 'You are not seated' }
    if (p.isBot) return { ok: false, error: 'Bots cannot leave' }
    const name = p.name
    const wasHost = p.id === this.hostId

    if (socketId && this.io) this.io.to(socketId).emit('room:left', { reason: 'You left the game' })
    this.sockets.delete(socketId)

    if (this.phase === 'playing' && this.engine) {
      // In a running game: an AI takes over the seat
      this.takeOverByBot(p)
      if (wasHost) this.transferHost()
      const en = this.chatLang === 'en'
      this.addLog(en ? `${name} left — an AI took over the seat` : `${name} 离开了 — AI 接管了座位`)
      this.pushChat('System', en ? `${name} has left — an AI is now playing their seat.` : `${name} 离开了 — 现在由 AI 接管这个座位。`)
    } else {
      // Lobby (or between games): just free the seat, no takeover
      this.seats[p.seat] = null
      if (wasHost) this.transferHost()
      this.addLog(`${name} left the room`)
    }

    // The last human leaving takes the whole room down with them
    if (!this.seatedPlayers().some((q) => !q.isBot)) {
      this.destroy()
      return { ok: true }
    }
    this.broadcast()
    return { ok: true }
  }

  // Convert a (human) seat into an AI seat, keeping its chips and — if a hand
  // is underway — its hole cards and its place in the betting.
  takeOverByBot(seatPlayer) {
    // Keep the player's name and avatar — an AI now plays the same seat.
    seatPlayer.isBot = true
    seatPlayer.socketId = null
    seatPlayer.afk = false
    seatPlayer.rebuyCount = 0
    seatPlayer._handVpip = false
    seatPlayer._handPfr = false
    seatPlayer._preflopRaised = false

    // Mid-hand: the engine's copy must also become a bot so the scheduler plays
    // it, and so it keeps its already-dealt hole cards. Name stays unchanged.
    if (this.engine && this.phase === 'playing') {
      const ep = this.engine.playerById(seatPlayer.id)
      if (ep) {
        ep.isBot = true
        if (this.engine.currentActor?.id === seatPlayer.id) {
          this.scheduleTurn()
        }
      }
    }
  }

  // Opt-in reveal: after a hand ends, a player chooses WHICH hole cards to
  // show — one specific card, both, or (via declineReveal) none. Folded
  // players may also show (e.g. to display a bluff); only unfolded human
  // contestants gate the early start of the next hand.
  reveal(playerId, { cards } = {}) {
    if (this.phase !== 'playing' || !this.engine || this.engine.phase !== 'handEnd') {
      return { ok: false, error: 'Reveal is only available right after a hand ends' }
    }
    const p = this.engine.playerById(playerId)
    if (!p) return { ok: false, error: 'You were not in this hand' }
    const picked = [...new Set((Array.isArray(cards) ? cards : []).map(Number))]
      .filter((i) => Number.isInteger(i) && i >= 0 && i < p.hole.length)
      .sort((a, b) => a - b)
    if (!picked.length) return { ok: false, error: 'Choose at least one card to show' }
    const merged = [...new Set([...(this.revealed.get(playerId) ?? []), ...picked])].sort((a, b) => a - b)
    this.revealed.set(playerId, merged)
    this.revealDeclined.delete(playerId)
    this.addLog(`${p.name} shows ${merged.map((i) => cardLabel(p.hole[i])).join(' ')}`)
    this.broadcast()
    this.maybeAdvanceAfterReveal()
    return { ok: true, revealed: merged }
  }

  // Explicitly keep the hand hidden. Counting as a decision, it lets the table
  // move on without waiting out the full reveal window.
  declineReveal(playerId) {
    if (this.phase !== 'playing' || !this.engine || this.engine.phase !== 'handEnd') {
      return { ok: false, error: 'Reveal is only available right after a hand ends' }
    }
    const p = this.engine.playerById(playerId)
    if (!p) return { ok: false, error: 'You were not in this hand' }
    if ((this.revealed.get(playerId) ?? []).length) {
      return { ok: false, error: 'You already showed cards' }
    }
    this.revealDeclined.add(playerId)
    this.broadcast()
    this.maybeAdvanceAfterReveal()
    return { ok: true }
  }

  // Close the reveal window early once every human contestant still seated has
  // decided (shown any cards or declined): the next hand starts after a short
  // grace, but never sooner than the minimum result display time. With no
  // pending humans this runs right at hand end, restoring the short pause.
  maybeAdvanceAfterReveal() {
    if (!this.engine || this.phase !== 'playing' || this.engine.phase !== 'handEnd') return
    const decided = (id) => (this.revealed.get(id) ?? []).length > 0 || this.revealDeclined.has(id)
    const pendingContestant = this.engine.players.some((ep) => {
      if (ep.folded || ep.isBot) return false
      const seatP = this.seats[ep.seat]
      return seatP?.id === ep.id && !seatP.isBot && !decided(ep.id)
    })
    if (pendingContestant) return
    const floor = this.handEndsAt + CONFIG.HAND_END_PAUSE_MS
    this.revealEndsAt = Math.max(floor, Math.min(this.revealEndsAt, Date.now() + 2000))
    this.revealDurationMs = this.revealEndsAt - this.handEndsAt
    if (this.handTimer) clearTimeout(this.handTimer)
    this.handTimer = setTimeout(() => {
      this.handTimer = null
      this.startHand()
    }, Math.max(0, this.revealEndsAt - Date.now()))
    this.broadcast()
  }

  // ==== Chat ====

  sendChat(playerId, text) {
    const p = this.playerById(playerId)
    if (!p) return { ok: false, error: 'You are not seated' }
    const now = Date.now()
    if (now - (p.lastChatAt || 0) < CONFIG.CHAT_COOLDOWN_MS) {
      return { ok: false, error: 'Sending messages too fast' }
    }
    const clean = String(text || '')
      .replace(/[\u0000-\u001f]/g, ' ') // strip control chars
      .trim()
      .slice(0, CONFIG.CHAT_MAX_LEN)
    if (!clean) return { ok: false, error: 'Empty message' }
    p.lastChatAt = now
    this.chat.push({ id: `${now}-${Math.random().toString(36).slice(2, 7)}`, name: p.name, text: clean, t: now })
    if (this.chat.length > 50) this.chat.splice(0, this.chat.length - 50)
    this.broadcast()
    // A human just spoke → bots reply (100%: every human message gets a reply),
    // chaining into a continuous conversation in the room's chosen language.
    this.triggerBanter({ id: p.id, name: p.name, icon: p.icon, isBot: false }, clean, { lang: this.chatLang, depth: 0 })
    return { ok: true }
  }

  // Append a chat line directly (no cooldown) — used by AI banter and by
  // spectator chat, which bypass the seated-player cooldown path.
  pushChat(name, text) {
    this.chat.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, text, t: Date.now() })
    if (this.chat.length > 50) this.chat.splice(0, this.chat.length - 50)
  }

  sendSpectatorChat(socketId, text) {
    const spec = this.spectators.get(socketId)
    if (!spec) return { ok: false, error: 'You are not in this room' }
    const clean = String(text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, CONFIG.CHAT_MAX_LEN)
    if (!clean) return { ok: false, error: 'Empty message' }
    this.pushChat(spec.name, clean)
    this.broadcast()
    // Spectators are real humans too → their messages trigger bot banter
    this.triggerBanter({ id: spec.id, name: spec.name, icon: null, isBot: false }, clean, { lang: this.chatLang, depth: 0 })
    return { ok: true }
  }

  // ==== AI banter ====
  //
  // Two trigger sources:
  //   1. A human (or spectator) sends a chat message → exactly ONE bot replies;
  //      that bot's line may then trigger one further reply, forming a single
  //      coherent thread (each reply follows on from the previous speaker), with
  //      reply probability decaying by depth.
  //   2. A bot wins or busts at hand end → its relationship partners react
  //      (e.g. 42↔Jeremiah, Mima↔Hazeshade). Preset one-liners (AI_WIN/AI_BUST)
  //      are pushed directly and are NOT reply-triggered; AI_CHAMPION is always
  //      English.
  //
  // Inter-bot reply probabilities come from the relationship matrix
  // (personas.js replyProb): couples/confidants high, sworn enemies 0, etc.

  // Build a compact, bot's-eye game context for the banter prompt: the
  // community, the pot, and the bot's chip stack. The bot's OWN hole cards are
  // withheld while a hand is in progress — otherwise the bot leaks them in chat
  // (e.g. "我这 A♦ J♥ ..."), which is a poker rule violation. They are only
  // revealed to the prompt once the hand is over (phase === 'handEnd'), since
  // at that point the cards are public anyway. We NEVER expose another player's
  // hole cards. Returns null when no hand is in progress.
  banterGameContext(botId) {
    if (!this.engine || this.phase !== 'playing') return null
    const ep = this.engine.playerById(botId)
    if (!ep) return null
    const handOver = this.engine.phase === 'handEnd'
    return {
      phase: this.engine.phase,
      community: this.engine.community.map(cardLabel).join(' ') || null,
      yourHand: handOver ? (ep.hole.map(cardLabel).join(' ') || null) : null,
      pot: this.engine.potForDisplay(),
      yourChips: ep.chips,
    }
  }

  // Trigger a single banter reply to `speaker` (human or bot) who said `text`.
  // `lang` is the room's chat language, propagated through the chain. `depth` is
  // the chain depth; reply probability decays with depth. `event` flags a
  // win/bust reaction rather than a chat reply. At most one bot replies per call,
  // so the conversation is a single coherent thread.
  //
  // Rules:
  //   - A HUMAN message is ALWAYS replied to (100%), by one bot chosen uniformly
  //     at random (no relationship weighting). @-mentioning a bot overrides this:
  //     that bot replies 100%, alone.
  //   - A BOT's line (a reply, or its win/bust reaction) is replied to with 50%
  //     probability; the responder is chosen weighted by the relationship matrix
  //     (replyProb). Chain depth is capped.
  triggerBanter(speaker, text, { lang, depth = 0, event = null }) {
    if (!this.aiChat || !banterEnabled()) return
    if (depth >= CONFIG.BANTER_MAX_DEPTH) return
    const bots = this.seatedPlayers().filter((p) => p.isBot && p.id !== speaker.id)
    if (!bots.length) return

    const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase().replace(/jr\.?$/, '')
    const normalized = norm(text || '')

    // A human @-mentioning a bot by name → that bot answers 100%, alone.
    if (!speaker.isBot) {
      const mentioned = bots.find((b) => {
        const name = norm(b.name)
        return name.length >= 2 && normalized.includes(name)
      })
      if (mentioned) {
        this.scheduleBanter(mentioned, speaker, text, { lang, depth, event, addressed: true })
        return
      }
    }

    let responder = null
    if (!speaker.isBot) {
      // Human message (no @-mention): 100% chance one bot replies, chosen
      // uniformly at random. Skip bots on cooldown if possible.
      const pool = bots.filter((b) => Date.now() - (b.lastBanterAt || 0) > CONFIG.BANTER_BOT_COOLDOWN_MS)
      const choice = pool.length ? pool : bots
      responder = choice[Math.floor(Math.random() * choice.length)]
    } else {
      // Bot spoke → 50% chance another bot replies, chosen weighted by
      // relationship probability (depth decay applies).
      if (Math.random() >= CONFIG.BANTER_CHAIN_PROB) return
      const decay = Math.pow(CONFIG.BANTER_DECAY, depth)
      const candidates = []
      for (const bot of bots) {
        if (Date.now() - (bot.lastBanterAt || 0) < CONFIG.BANTER_BOT_COOLDOWN_MS) continue
        const prob = replyProb(speaker.icon, bot.icon) * decay
        if (prob > 0) candidates.push({ bot, prob })
      }
      if (candidates.length) responder = weightedPick(candidates)
    }

    if (responder) this.scheduleBanter(responder, speaker, text, { lang, depth, event })
  }

  // A bot won / busted → its relationship partners react (LLM banter). Only bot
  // subjects trigger this (relationships are between AIs). Uses the room's
  // chosen chat language.
  triggerEventBanter(subject, type) {
    if (!subject || !subject.isBot) return
    this.triggerBanter(
      { id: subject.id, name: subject.name, icon: subject.icon, isBot: true },
      null,
      { lang: this.chatLang, depth: 0, event: { type, subjectName: subject.name } }
    )
  }

  // Schedule one bot to (after a typing delay) generate and post a banter line,
  // then continue the chain from its own line. `addressed` means the speaker
  // @-mentioned this bot by name — the reply must directly answer the message.
  scheduleBanter(bot, speaker, text, { lang, depth, event, addressed = false }) {
    const delay = randInt(CONFIG.BANTER_DELAY_MIN_MS, CONFIG.BANTER_DELAY_MAX_MS)
    const roomId = this.id
    const botId = bot.id
    const botIcon = bot.icon
    const speakerName = speaker.name
    setTimeout(() => {
      const room = rooms.get(roomId)
      if (!room || room !== this) return
      const seatP = room.playerById(botId)
      if (!seatP || !seatP.isBot) return
      const game = room.banterGameContext(botId)
      generateBanter({ botIcon, speakerName, speakerText: text, game, lang, event, addressed })
        .then((line) => {
          if (!line) return
          const r = rooms.get(roomId)
          if (!r || r !== this) return
          const b = r.playerById(botId)
          if (!b || !b.isBot) return
          b.lastBanterAt = Date.now()
          r.pushChat(b.name, line)
          r.broadcast()
          // Continue the thread — UNLESS this was a direct @-address: when someone
          // @-names a bot, only that bot replies (the chain stops, no piggybacking).
          if (!addressed) {
            r.triggerBanter({ id: b.id, name: b.name, icon: b.icon, isBot: true }, line, {
              lang,
              depth: depth + 1,
            })
          }
        })
        .catch(() => {})
    }, delay)
  }

  // A spectator takes a free seat and joins the game (once a seat is open).
  sit(socketId) {
    const spec = this.spectators.get(socketId)
    if (!spec) return { ok: false, error: 'You are not spectating' }
    const seat = this.seats.findIndex((s) => s === null)
    if (seat === -1) return { ok: false, error: 'No free seat right now' }
    const player = {
      id: spec.id,
      seat,
      name: spec.name,
      isBot: false,
      icon: this.pickAvatar(),
      chips: this.startingChips,
      socketId,
      wins: 0,
      rebuyCount: 0,
      profile: newProfile(),
      _handVpip: false,
      _handPfr: false,
      _preflopRaised: false,
      afk: false,
    }
    this.seats[seat] = player
    this.sockets.set(socketId, player.id)
    this.spectators.delete(socketId)
    if (!this.hostId) this.hostId = player.id
    this.renameCollidingBots(player.name)
    this.addLog(`${player.name} joined the game`)
    this.broadcast()
    return { ok: true, playerId: player.id }
  }

  // A seated player switches to spectating (frees their seat). Used mostly in
  // the lobby, where joining normally seats you.
  becomeSpectator(playerId, socketId) {
    const p = this.playerById(playerId)
    if (!p) return { ok: false, error: 'You are not seated' }
    if (p.isBot) return { ok: false, error: 'Bots cannot spectate' }
    const name = p.name
    this.seats[p.seat] = null
    this.sockets.delete(socketId)
    this.spectators.set(socketId, { id: p.id, name, socketId })
    if (p.id === this.hostId) this.transferHost()
    this.addLog(`${name} is now spectating`)
    if (!this.seatedPlayers().some((q) => !q.isBot)) {
      this.destroy()
      return { ok: true }
    }
    this.broadcast()
    return { ok: true, playerId: p.id, spectator: true }
  }

  // Human clicked "back to game": clear their 托管 flag and, if it's currently
  // their turn, restart their full-length timer.
  returnToGame(playerId) {
    const p = this.playerById(playerId)
    if (!p) return { ok: false, error: 'You are not seated' }
    p.afk = false
    this.addLog(`${p.name} is back`)
    if (this.phase === 'playing' && this.engine?.currentActor?.id === playerId) {
      this.scheduleTurn()
    }
    this.broadcast()
    return { ok: true }
  }

  // Track opponent tendencies for the AI: VPIP/PFR per hand, and how often a
  // player folds when facing a bet (fold-to-bet → fold equity). Called on every
  // successful action, human and bot alike.
  observeProfile(playerId, phase, legal, action) {
    const seatP = this.playerById(playerId)
    const prof = seatP?.profile
    if (!prof) return
    if (phase === 'preflop') {
      if (!seatP._handVpip && (action.type === 'call' || action.type === 'raise')) {
        seatP._handVpip = true
        prof.vpip++
      }
      if (!seatP._handPfr && action.type === 'raise') {
        seatP._handPfr = true
        prof.pfr++
      }
      if (action.type === 'raise') seatP._preflopRaised = true
    }
    if (legal && legal.toCall > 0) {
      prof.facedBet++
      if (action.type === 'fold') prof.foldedToBet++
    }
  }

  destroy() {
    this.clearTimers()
    if (this.lobbyExpireTimer) {
      clearTimeout(this.lobbyExpireTimer)
      this.lobbyExpireTimer = null
    }
    // Spectators watch a live room; close them out too.
    if (this.io) {
      for (const socketId of this.spectators.keys()) {
        this.io.to(socketId).emit('room:closed', { reason: 'Room closed' })
      }
    }
    this.spectators.clear()
    this.phase = 'lobby'
    rooms.delete(this.id)
  }

  // ==== Game loop ====

  start(actorId) {
    if (actorId !== this.hostId) return { ok: false, error: 'Only the host can start the game' }
    if (this.phase === 'playing') return { ok: false, error: 'Game already in progress' }
    this.started = true
    if (this.lobbyExpireTimer) {
      clearTimeout(this.lobbyExpireTimer)
      this.lobbyExpireTimer = null
    }
    // Starting a new game: reset every seat's chips to the starting stack
    // (the previous game's champion is already recorded in the log)
    for (const p of this.seatedPlayers()) {
      p.chips = this.startingChips
      p.rebuyCount = 0
    }
    this.gameOver = null
    this.dealerSeat = null
    const present = this.seatedPlayers().filter((p) => p.isBot || p.socketId != null)
    if (present.length < CONFIG.MIN_PLAYERS) {
      return { ok: false, error: `At least ${CONFIG.MIN_PLAYERS} online players are needed (add AI to fill seats)` }
    }
    this.phase = 'playing'
    this.addLog('Game started!')
    this.startHand()
    return { ok: true }
  }

  startHand() {
    this.clearTimers()
    this.revealed = new Map()
    this.revealDeclined = new Set()
    this.handEndsAt = null
    this.revealEndsAt = null
    this.revealDurationMs = null
    const eligible = this.eligiblePlayers()
    if (this.phase !== 'playing' || eligible.length < CONFIG.MIN_PLAYERS) {
      this.endGame(eligible)
      return
    }

    // Count this hand toward each dealt player's stats and reset the per-hand
    // tracking flags that observeProfile sets.
    for (const p of eligible) {
      if (p.profile) p.profile.hands++
      p._handVpip = false
      p._handPfr = false
      p._preflopRaised = false
    }

    // Dealer rotates by seat order
    const seats = eligible.map((p) => p.seat)
    if (this.dealerSeat == null || !seats.includes(this.dealerSeat)) {
      this.dealerSeat = seats[0]
    } else {
      this.dealerSeat = seats[(seats.indexOf(this.dealerSeat) + 1) % seats.length]
    }
    this.handCount++

    this.engine = new PokerGame({
      players: eligible.map((p) => ({ ...p })),
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      initialDealerIndex: eligible.findIndex((p) => p.seat === this.dealerSeat),
      onResult: (result) => this.onHandEnd(result),
    })
    this.engine.handNumber = this.handCount - 1 // startHand increments it; align with room count

    this.addLog(`—— Hand ${this.handCount} ——`)
    this.engine.startHand()
    this.scheduleTurn()
    this.broadcast()
  }

  endGame(eligible = this.eligiblePlayers()) {
    this.clearTimers()
    this.engine = null
    this.phase = 'lobby'
    const champ = eligible[0]
    if (champ) {
      this.addLog(`🏆 ${champ.name} wins the whole game!`)
      // Settlement data for the client's victory screen: champion + final
      // standings of every seat, ranked by remaining chips
      const standings = this.seatedPlayers()
        .map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, icon: p.icon, chips: p.chips, wins: p.wins || 0 }))
        .sort((a, b) => b.chips - a.chips)
        .map((p, i) => ({ ...p, rank: i + 1 }))
      this.gameOver = {
        id: `${this.handCount}-${Date.now()}`, // lets clients dedupe dismissal across games
        champion: {
          id: champ.id,
          name: champ.name,
          isBot: champ.isBot,
          icon: champ.icon,
          chips: champ.chips,
          wins: champ.wins || 0,
        },
        championSpeech: champ.isBot ? AI_CHAMPION[champ.icon] : null,
        hands: this.handCount,
        standings,
      }
    }
    this.broadcast()
  }

  onHandEnd() {
    this.clearTurnTimer()
    // Engine players are copies of the seated players; write settled chips back
    for (const ep of this.engine.players) {
      const seatP = this.seats[ep.seat]
      if (seatP && seatP.id === ep.id) seatP.chips = ep.chips
    }
    const result = this.engine.lastResult
    // Persist a win for each winner on their seat (shown as a hand counter)
    for (const w of result.winners) {
      const seatP = this.seats.find((s) => s && s.id === w.id)
      if (seatP) seatP.wins = (seatP.wins || 0) + 1
    }
    if (result.uncontested) {
      const w = result.winners[0]
      this.addLog(`Everyone else folded — ${w.name} wins ${w.amount}`)
    } else {
      for (const w of result.winners) {
        const reveal = result.reveal.find((r) => r.id === w.id)
        this.addLog(`${w.name}${reveal ? ` (${reveal.handName})` : ''} wins ${w.amount}`)
      }
    }
    // Auto-reveal AI players who did NOT fold — showdown hands and uncontested
    // winners show their cards, while a folded AI keeps them face-down.
    for (const ep of this.engine.players) {
      if (!ep.isBot || ep.folded) continue
      this.revealed.set(ep.id, ep.hole.map((_, i) => i))
    }
    // Winner bots boast; a bot that just busted out sends its farewell. Bots
    // that lost but still have chips stay quiet.
    const winners = new Set((result.winners || []).map((w) => w.id))
    for (const ep of this.engine.players) {
      if (!ep.isBot) continue
      const seatP = this.seats[ep.seat]
      const icon = seatP?.icon
      if (!icon) continue
      if (winners.has(ep.id)) {
        const line = AI_WIN[this.chatLang]?.[icon]
        if (line) this.pushChat(ep.name, line)
      } else if (ep.chips === 0) {
        const line = AI_BUST[this.chatLang]?.[icon]
        if (line) this.pushChat(ep.name, line)
      }
    }
    // Relationship-driven event reactions: ONE bot partner reacts to the hand's
    // outcome (e.g. 42↔Jeremiah, Mima↔Hazeshade). Only the first bot winner/bust
    // subject triggers a single banter chain (one AI replies, then the chain may
    // continue — but no parallel chains per hand end). Preset one-liners above
    // are NOT reply-triggered.
    let eventSubject = null
    let eventType = null
    for (const w of result.winners || []) {
      const seatP = this.seats.find((s) => s && s.id === w.id)
      if (seatP?.isBot) { eventSubject = seatP; eventType = 'win'; break }
    }
    if (!eventSubject) {
      for (const ep of this.engine.players) {
        if (ep.isBot && ep.chips === 0) {
          const seatP = this.seats[ep.seat]
          if (seatP) { eventSubject = seatP; eventType = 'bust'; break }
        }
      }
    }
    if (eventSubject) this.triggerEventBanter(eventSubject, eventType)
    this.broadcast()
    // Reveal window: players have up to REVEAL_WINDOW_MS to decide whether and
    // which cards to show. The next hand starts much earlier once everyone
    // eligible has decided (or right past the floor when nobody has a choice).
    this.handEndsAt = Date.now()
    this.revealEndsAt = this.handEndsAt + CONFIG.REVEAL_WINDOW_MS
    this.revealDurationMs = CONFIG.REVEAL_WINDOW_MS
    this.handTimer = setTimeout(() => {
      this.handTimer = null
      this.startHand()
    }, CONFIG.REVEAL_WINDOW_MS)
    this.maybeAdvanceAfterReveal()
  }

  // ==== Actions ====

  applyAction(playerId, action) {
    if (this.phase !== 'playing' || !this.engine) return { ok: false, error: 'No game in progress' }
    if (!action || typeof action.type !== 'string') return { ok: false, error: 'Invalid action' }
    const res = this.step(playerId, action)
    if (res.ok) {
      // Acting manually means the human is back from 托管
      const p = this.playerById(playerId)
      if (p && p.afk) {
        p.afk = false
        this.broadcast()
      }
    }
    return res
  }

  // Execute one action and handle progression, logging and broadcasting;
  // returns an error if the decision is illegal
  step(playerId, action) {
    const phase = this.engine.phase
    const legal = this.engine.getLegalActions(playerId)
    const prevCommunity = this.engine.community.length
    const res = this.engine.act(playerId, action)
    if (!res.ok) return res
    this.observeProfile(playerId, phase, legal, action)
    this.logAction(playerId, action)
    if (this.engine.community.length > prevCommunity && this.engine.phase !== 'handEnd') {
      this.addLog(`Board: ${this.engine.community.map(cardLabel).join(' ')}`)
    }
    this.scheduleTurn()
    this.broadcast()
    return { ok: true }
  }

  logAction(playerId, action) {
    const p = this.engine.playerById(playerId)
    if (!p) return
    if (action.type === 'fold') this.addLog(`${p.name} folds`)
    else if (action.type === 'check') this.addLog(`${p.name} checks`)
    else if (action.type === 'call') this.addLog(`${p.name} ${p.allIn ? 'calls all-in' : 'calls'} ${p.bet}`)
    else if (action.type === 'raise') this.addLog(`${p.name} ${p.allIn ? 'shoves all-in' : 'raises to'} ${p.bet}`)
  }

  // ==== Turn scheduling ====

  clearTurnTimer() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer)
      this.turnTimer = null
    }
    this.turnEndsAt = null
    this.turnDurationMs = null
  }

  clearTimers() {
    this.clearTurnTimer()
    if (this.handTimer) {
      clearTimeout(this.handTimer)
      this.handTimer = null
    }
  }

  scheduleTurn(timeoutOverrideMs = null) {
    this.clearTurnTimer()
    if (!this.engine || this.engine.phase === 'handEnd') return
    const actor = this.engine.currentActor
    if (!actor) return

    if (actor.isBot) {
      if (llmEnabled()) {
        // LLM bot: trigger quickly, show a longer "thinking" window on the timer
        const delay = randInt(CONFIG.AI_ACT_MIN_MS, CONFIG.AI_ACT_MAX_MS)
        const window = Math.max(CONFIG.LLM_TURN_MS, delay + 1500)
        this.turnEndsAt = Date.now() + window
        this.turnDurationMs = window
        this.turnTimer = setTimeout(() => this.botAct(actor.id), delay)
      } else {
        const delay = randInt(CONFIG.AI_ACT_MIN_MS, CONFIG.AI_ACT_MAX_MS)
        this.turnEndsAt = Date.now() + delay
        this.turnDurationMs = delay
        this.turnTimer = setTimeout(() => this.botAct(actor.id), delay)
      }
    } else {
      // Online status must come from the room's seat player (which carries
      // socketId); the engine player is a stripped copy without that field.
      const seatP = this.playerById(actor.id)
      const online = !!seatP?.socketId
      if (seatP?.afk) {
        // AFK 托管: each turn gets only a short window, then auto-fold
        const timeout = CONFIG.AFK_TURN_MS
        this.turnEndsAt = Date.now() + timeout
        this.turnDurationMs = timeout
        this.turnTimer = setTimeout(() => this.autoFold(actor.id), timeout)
      } else if (!online) {
        // Disconnected: shorten the wait so the table doesn't stall
        const timeout = timeoutOverrideMs ?? CONFIG.OFFLINE_ACTION_TIMEOUT_MS
        this.turnEndsAt = Date.now() + timeout
        this.turnDurationMs = timeout
        this.turnTimer = setTimeout(() => this.autoAct(actor.id), timeout)
      } else {
        // Connected but silent: full window, then drop into 托管 and fold
        const timeout = CONFIG.ACTION_TIMEOUT_MS
        this.turnEndsAt = Date.now() + timeout
        this.turnDurationMs = timeout
        this.turnTimer = setTimeout(() => this.onHumanTimeout(actor.id), timeout)
      }
    }
  }

  // Human timeout → drop the player into 托管 and fold this turn.
  onHumanTimeout(playerId) {
    this.turnTimer = null
    if (!this.engine || this.engine.currentActor?.id !== playerId) return
    const seatP = this.playerById(playerId)
    if (seatP) seatP.afk = true
    this.autoFold(playerId)
  }

  // Disconnected (offline) auto-act: fold if facing a raise, else check.
  autoAct(playerId) {
    this.turnTimer = null
    if (!this.engine || this.engine.currentActor?.id !== playerId) return
    const legal = this.engine.getLegalActions(playerId)
    const p = this.engine.playerById(playerId)
    const facingRaise = !legal.check
    const action = facingRaise ? { type: 'fold' } : { type: 'check' }
    this.addLog(`${p.name} is offline — auto-${facingRaise ? 'folded (facing a raise)' : 'checked'}`)
    this.step(playerId, action)
  }

  // AFK 托管: fold on their turn (we never decide for them — just fold).
  autoFold(playerId) {
    this.turnTimer = null
    if (!this.engine || this.engine.currentActor?.id !== playerId) return
    const p = this.engine.playerById(playerId)
    this.addLog(`${p.name} is away — auto-folding`)
    this.step(playerId, { type: 'fold' })
  }

  async botAct(botId) {
    try {
      await this.runBotAct(botId)
    } catch (e) {
      // Never let a bot crash the server; recover with check/fold if it's still our turn
      console.error('[bot] botAct error:', e)
      if (this.engine && this.phase === 'playing' && this.engine.currentActor?.id === botId) {
        const legal = this.engine.getLegalActions(botId)
        this.step(botId, legal?.check ? { type: 'check' } : { type: 'fold' })
      }
    }
  }

  async runBotAct(botId) {
    this.turnTimer = null
    if (!this.engine || this.engine.currentActor?.id !== botId) return
    const actor = this.engine.currentActor
    const legal = this.engine.getLegalActions(botId)

    // Position: 0 = first to act after the dealer (early), 1 = dealer button (late)
    const players = this.engine.players
    const n = players.length
    const dist = (players.indexOf(actor) - this.engine.dealerIndex + n) % n
    const position = n <= 1 ? 1 : ((dist - 1 + n) % n) / (n - 1)

    const ctx = {
      hole: actor.hole,
      community: this.engine.community,
      toCall: legal.toCall,
      currentBet: this.engine.streetBet,
      potSize: this.engine.potForDisplay(),
      legal,
      position,
      bigBlind: this.bigBlind,
      smallBlind: this.smallBlind,
      stack: actor.chips,
      opponents: players
        .filter((q) => q.id !== botId)
        .map((q) => {
          const seatP = this.playerById(q.id)
          return {
            name: q.name,
            stack: q.chips,
            bet: q.bet,
            folded: q.folded,
            profile: seatP?.profile ?? null,
            preflopRaised: !!seatP?._preflopRaised,
          }
        }),
      rng: Math.random,
    }

    // Ask the LLM first (if enabled); fall back to the heuristic AI
    let action = await llmDecide(ctx)
    const viaLlm = !!action
    if (!action) action = decide(ctx)

    // The hand may have moved on while awaiting the LLM — bail out if so
    if (!this.engine || this.phase !== 'playing' || this.engine.phase === 'handEnd' || this.engine.currentActor?.id !== botId) {
      return
    }

    console.log(`[bot] ${actor.name} ${action.type}${action.amount != null ? ` ${action.amount}` : ''}${viaLlm ? ' (LLM)' : ' (heuristic)'}`)
    let res = this.step(botId, action)
    if (!res.ok) {
      // Fallback if the decision was illegal
      res = this.step(botId, legal.check ? { type: 'check' } : { type: 'fold' })
    }
    return res
  }
}
