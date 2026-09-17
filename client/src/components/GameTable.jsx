import { useEffect, useRef } from 'react'
import Seat from './Seat.jsx'
import Card from './Card.jsx'
import ActionBar from './ActionBar.jsx'
import ChatBox from './ChatBox.jsx'
import { PHASE_NAMES, tableLayout } from '../lib.js'

// Main game screen: table + seats + community cards + action bar + log.
export default function GameTable({ state, onAction, onRebuy, onReveal, onDeclineReveal, onChat, onLeave }) {
  const { room, game } = state
  const youId = room.youId
  const players = game?.players ?? []

  // Rotate "you" to the bottom seat; others follow in seat order
  const youIdx = players.findIndex((p) => p.id === youId)
  const ordered = youIdx > 0 ? [...players.slice(youIdx), ...players.slice(0, youIdx)] : players
  const layout = tableLayout(ordered.length || 1)

  const dealerSeat = game?.dealerSeat ?? null
  const winners = game?.phase === 'handEnd' ? new Set(game.lastResult.winners.map((w) => w.id)) : new Set()
  const result = game?.phase === 'handEnd' ? game.lastResult : null

  // Players not in the current hand (busted / offline) shown in the bench area
  const inHandIds = new Set(players.map((p) => p.id))
  const bench = room.seats.filter(Boolean).filter((p) => !inHandIds.has(p.id))

  return (
    <div className="screen game-screen">
      <header className="top-bar">
        <span className="brand">🐺 Texas Hold'em</span>
        <span className="room-code">
          Room <b>{room.id}</b>
        </span>
        <span className="hand-no">{game ? `Hand #${game.handNumber}` : ''}</span>
        <span className="blinds">
          Blinds {room.smallBlind}/{room.bigBlind}
        </span>
        <span className="phase">{game ? PHASE_NAMES[game.phase] ?? game.phase : ''}</span>
        {!room.youSpectating ? (
          <button className="btn btn-ghost leave-btn" onClick={onLeave}>
            Leave
          </button>
        ) : null}
      </header>

      <div className="game-body">
        <div className="table-wrap">
          <div className="felt">
            <div className="pot">Pot {game?.pot ?? 0}</div>
            <div className="community">
              {Array.from({ length: 5 }, (_, i) => (
                <Card key={i} card={game?.community[i] ?? null} />
              ))}
            </div>
            {result ? <ResultBanner result={result} /> : null}
          </div>

          {ordered.map((p, i) => (
            <div key={p.id}>
              <div className="seat-slot" style={{ left: `${layout[i].x}%`, top: `${layout[i].y}%` }}>
                <Seat
                  p={p}
                  isDealer={p.seat === dealerSeat}
                  isActor={game?.currentTurn === p.id && game.phase !== 'handEnd'}
                  isWinner={winners.has(p.id)}
                  endsAt={room.turnEndsAt}
                  duration={room.turnDurationMs}
                />
              </div>
              {p.bet > 0 ? (
                <div className="bet-chip" style={{ left: `${layout[i].bx}%`, top: `${layout[i].by}%` }}>
                  {p.bet}
                </div>
              ) : null}
            </div>
          ))}

          {bench.length > 0 ? (
            <div className="bench">
              <span className="bench-title">Waiting for next hand:</span>
              {bench.map((p) => (
                <span key={p.id} className={`bench-player ${p.id === youId ? 'me' : ''}`}>
                  {p.name} ({p.chips})
                  {p.id === youId && p.chips === 0 ? (
                    p.remainingRebuys > 0 ? (
                      <button className="mini-btn" onClick={onRebuy}>
                        Rebuy ({p.remainingRebuys} left)
                      </button>
                    ) : (
                      <span className="bench-out">Eliminated</span>
                    )
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <LogPanel log={state.log} />
      </div>

      <ActionBar
        game={game}
        bigBlind={room.bigBlind}
        smallBlind={room.smallBlind}
        onAction={onAction}
        onReveal={onReveal}
        onDeclineReveal={onDeclineReveal}
        endsAt={room.turnEndsAt}
        duration={room.turnDurationMs}
        revealEndsAt={room.revealEndsAt}
        revealDurationMs={room.revealDurationMs}
      />

      <ChatBox chat={state.chat} onSend={onChat} />
    </div>
  )
}

function ResultBanner({ result }) {
  const text = result.winners.map((w) => `${w.name} wins ${w.amount}`).join(', ')
  return <div className="result-banner">🎉 {text}</div>
}

function LogPanel({ log }) {
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [log.length])
  return (
    <aside className="log-panel">
      <div className="log-title">Game Log</div>
      <div className="log-list" ref={ref}>
        {log.map((e, i) => (
          <div key={i} className="log-entry">
            {e.text}
          </div>
        ))}
      </div>
    </aside>
  )
}
