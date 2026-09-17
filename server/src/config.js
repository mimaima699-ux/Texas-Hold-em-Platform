// Global constants and default configuration
export const CONFIG = {
  PORT: Number(process.env.PORT) || 3001,
  // Action timeout for human players (ms) — their reaction window each turn
  ACTION_TIMEOUT_MS: 60000,
  // Shortened timeout when the acting player has disconnected (ms)
  OFFLINE_ACTION_TIMEOUT_MS: 8000,
  // Turn window for a human in AFK mode — short, then auto-folds
  AFK_TURN_MS: 5000,
  // AI "thinking" delay before a bot acts. The LLM/heuristic itself is fast
  // (~200ms / ~40ms), so this is purely cosmetic pacing — kept short so the
  // table doesn't crawl when bots act many times per hand.
  AI_ACT_MIN_MS: 150,
  AI_ACT_MAX_MS: 450,
  // LLM-powered AI: any OpenAI-compatible endpoint. Endpoint unreachable
  // or unset → the heuristic AI (aiPlayer.js) is used automatically.
  // Local Ollama / vLLM / LM Studio / SiliconFlow / OpenRouter / DashScope all work.
  LLM_BASE_URL: process.env.LLM_BASE_URL || 'http://localhost:11434/v1',
  LLM_MODEL: process.env.LLM_MODEL || 'qwen2.5:7b',
  LLM_API_KEY: process.env.LLM_API_KEY || '', // not needed for local services
  LLM_TIMEOUT_MS: Number(process.env.LLM_TIMEOUT_MS) || 12000, // per-request timeout
  // Visible turn window for LLM bots (they need a few seconds to think)
  LLM_TURN_MS: Number(process.env.LLM_TURN_MS) || 14000,
  // Minimum result display time between end of a hand and the start of the
  // next (ms). The gap can stretch up to REVEAL_WINDOW_MS while players decide
  // whether to show their cards; it snaps back to this floor once everyone
  // eligible has decided (revealed or declined).
  HAND_END_PAUSE_MS: 5000,
  // Reveal window: how long after a hand ends players have to choose whether
  // to show their hole cards (one card, both, or none). The next hand starts
  // early once every human contestant has made their choice.
  REVEAL_WINDOW_MS: 60000,
  // Default room settings
  DEFAULT_STARTING_CHIPS: 100,
  DEFAULT_SMALL_BLIND: 5,
  DEFAULT_BIG_BLIND: 10,
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 9,
  // Hard cap on rebuys a host may grant (chosen at create; room default is 0).
  MAX_REBUYS: 10,
  // A lobby room that never starts a game is auto-closed after this long (ms).
  // Empty never-started rooms survive until this deadline (a page refresh
  // won't kill the invite link); rooms where a game has started close as
  // soon as the last human leaves.
  ROOM_LOBBY_EXPIRE_MS: Number(process.env.ROOM_LOBBY_EXPIRE_MS) || 3 * 60_000,
  // Chat: per-player message cooldown (ms) and max length
  CHAT_COOLDOWN_MS: 400,
  CHAT_MAX_LEN: 120,
  // AI banter: when a human sends a chat message, bots reply in their own
  // voices (LLM-generated), and their replies can chain into a continuous
  // conversation. Win/bust events also trigger relationship-driven reactions.
  BANTER_DELAY_MIN_MS: 1000, // min "typing" delay before a bot replies
  BANTER_DELAY_MAX_MS: 1000,
  BANTER_BOT_COOLDOWN_MS: 1500, // a bot won't speak twice within this window
  BANTER_CHAIN_PROB: 0.35, // chance a bot's line is replied to by another bot
  BANTER_MAX_DEPTH: 3, // a single message → at most 3 replies in the chain
  BANTER_DECAY: 0.4, // reply-probability decay per chain depth
  BANTER_DEFAULT_LANG: 'zh', // event-banter language before any human chat
}
