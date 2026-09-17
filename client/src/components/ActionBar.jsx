import { useEffect, useState } from 'react'
import { useCountdown } from './Seat.jsx'
import { rankText, SUIT_LABEL } from '../lib.js'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// Bottom action bar: shows Fold/Check/Call/Raise when it's your turn.
export default function ActionBar({
  game,
  bigBlind,
  smallBlind,
  onAction,
  onReveal,
  onDeclineReveal,
  endsAt,
  duration,
  revealEndsAt,
  revealDurationMs,
}) {
  const you = game?.you
  const isMyTurn = !!you && game.currentTurn === you.id && game.phase !== 'handEnd'

  if (!you) {
    return (
      <div className="action-bar">
        <div className="action-hint">Spectating · joining next hand</div>
      </div>
    )
  }
  if (game.phase === 'handEnd') {
    return (
      <RevealBar
        you={you}
        onReveal={onReveal}
        onDecline={onDeclineReveal}
        endsAt={revealEndsAt}
        duration={revealDurationMs}
      />
    )
  }
  if (you.folded) {
    return (
      <div className="action-bar">
        <div className="action-hint">You folded — waiting for this hand to end…</div>
      </div>
    )
  }
  if (!isMyTurn) {
    return (
      <div className="action-bar">
        <div className="action-hint">Waiting for other players…</div>
      </div>
    )
  }

  return (
    <ActiveBar
      you={you}
      game={game}
      bigBlind={bigBlind}
      smallBlind={smallBlind}
      onAction={onAction}
      endsAt={endsAt}
      duration={duration}
    />
  )
}

const cardText = (c) => (c ? `${rankText(c.rank)}${SUIT_LABEL[c.suit]}` : '')

// Hand-end bar: choose whether to show your hole cards — one specific card,
// both, or none — while the reveal-window countdown runs. Folded players get
// the same choice (show the bluff!); their decision just doesn't hold up the
// table.
function RevealBar({ you, onReveal, onDecline, endsAt, duration }) {
  const remaining = useCountdown(endsAt || 0)
  const revealed = you.revealedCards ?? []
  const hidden = you.hole.map((c, i) => ({ c, i })).filter(({ i }) => !revealed.includes(i))

  let body
  if (revealed.length >= you.hole.length) {
    body = <div className="action-hint">You showed your hand ({you.hole.map(cardText).join(' ')})</div>
  } else if (you.revealDeclined) {
    body = <div className="action-hint">You kept your hand hidden</div>
  } else {
    body = (
      <>
        {hidden.map(({ c, i }) => (
          <button key={i} className="btn btn-reveal" onClick={() => onReveal([i])}>
            👀 Show {cardText(c)}
          </button>
        ))}
        {hidden.length > 1 ? (
          <button className="btn btn-reveal" onClick={() => onReveal(you.hole.map((_, i) => i))}>
            👀 Show both
          </button>
        ) : null}
        {revealed.length === 0 ? (
          <button className="btn btn-fold" onClick={onDecline}>
            🚫 Don't show
          </button>
        ) : null}
      </>
    )
  }

  return (
    <div className="action-bar reveal-bar">
      {body}
      <span className="action-hint">
        {endsAt ? `Next hand in ${Math.ceil(remaining / 1000)}s` : 'Next hand starts soon…'}
      </span>
    </div>
  )
}

function ActiveBar({ you, game, bigBlind, smallBlind, onAction, endsAt, duration }) {
  const legal = you.legal
  const [raiseTo, setRaiseTo] = useState(legal.raiseMin)

  // Reset the slider when the legal range changes
  useEffect(() => {
    setRaiseTo(legal.raiseMin)
  }, [legal.raiseMin, legal.raiseMax, game.streetBet])

  const isAllIn = raiseTo >= legal.raiseMax
  const step = Math.max(1, smallBlind)

  // Quick raise sizes
  const potAfterCall = game.pot + legal.toCall
  const quick = (f) => clamp(Math.round(game.streetBet + legal.toCall + potAfterCall * f), legal.raiseMin, legal.raiseMax)

  return (
    <div className="action-bar active">
      <div className="timer-row">
        <CountdownBar endsAt={endsAt} duration={duration} />
      </div>
      <div className="buttons-row">
        <button className="btn btn-fold" onClick={() => onAction({ type: 'fold' })}>
          Fold
        </button>
        {legal.check && (
          <button className="btn btn-check" onClick={() => onAction({ type: 'check' })}>
            Check
          </button>
        )}
        {legal.canCall && (
          <button className="btn btn-call" onClick={() => onAction({ type: 'call' })}>
            {legal.call >= you.chips ? `Call all-in ${legal.call}` : `Call ${legal.call}`}
          </button>
        )}
        {legal.canRaise && (
          <div className="raise-group">
            <div className="quick-raises">
              <button onClick={() => setRaiseTo(legal.raiseMin)}>Min</button>
              <button onClick={() => setRaiseTo(quick(0.5))}>½ Pot</button>
              <button onClick={() => setRaiseTo(quick(1))}>Pot</button>
              <button onClick={() => setRaiseTo(legal.raiseMax)}>All-in</button>
            </div>
            <input
              type="range"
              min={legal.raiseMin}
              max={legal.raiseMax}
              step={step}
              value={raiseTo}
              onChange={(e) => setRaiseTo(Number(e.target.value))}
            />
            <span className="raise-amount">{isAllIn ? `All-in ${raiseTo}` : raiseTo}</span>
            <button className="btn btn-raise" onClick={() => onAction({ type: 'raise', amount: raiseTo })}>
              {isAllIn ? 'All-in' : 'Raise to'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function CountdownBar({ endsAt, duration }) {
  const remaining = useCountdown(endsAt)
  const pct = Math.max(0, Math.min(100, (remaining / duration) * 100))
  return (
    <div className={`countdown ${pct < 25 ? 'urgent' : ''}`}>
      <div className="countdown-bar" style={{ width: `${pct}%` }} />
    </div>
  )
}
