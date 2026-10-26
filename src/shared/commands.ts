import { EFFORTS, MODEL_NAME } from './chat-types'
import { COLOUR_HEX } from './cat3d/pet-spec'

/** Things typed or said to the pet that the app handles itself instead of sending to the assistant. */
export type ChatCommand =
  | { kind: 'model'; model: string }
  | { kind: 'effort'; effort: string }
  | { kind: 'new' }
  | { kind: 'look'; question: string }
  | { kind: 'help' }
  | { kind: 'pet'; text: string }
  | { kind: 'bad'; message: string }

/**
 * "turn my pet into a mermaid", "change my cat's skin to green", "make my pet wear a wizard hat". Deliberately narrow, so a normal
 * question about a real cat ("make dinner for my cat", "change my pet insurance") is never taken for a restyle: the object must be
 * the pet or cat itself, followed by a way of changing how it looks. `/pet <text>` always works.
 */
const NOUN = String.raw`(?:desk\s?pet|pet|cat|character|avatar|mascot)`
const POLITE = String.raw`^(?:(?:hey|ok|okay|please|can you|could you|would you)[,]? )*(?:please )?`
const LOOKS = String.raw`(?:skin|fur|colou?r|coat|look|appearance|outfit|costume|hat|clothes|style|eyes|ears|tail|face|hair|body|shape|size|design)`
const PET_REQUEST = new RegExp(
  `${POLITE}(?:` +
    `(?:turn|transform|morph)\\s+(?:my|the|this)\\s+${NOUN}\\s+(?:into|to)\\b` +
    `|(?:change|update|customi[sz]e|dress)\\s+(?:my|the|this)\\s+${NOUN}(?:'s)?\\s+${LOOKS}\\b` +
    `|(?:recolou?r|restyle|redesign|re-?skin|dress up|re-?paint)\\s+(?:my|the|this)\\s+${NOUN}\\b` +
    `|make\\s+(?:my|the|this)\\s+${NOUN}\\s+(?:look|wear|into|have|an?|bigger|smaller|larger|taller|tinier|tiny|giant|${Object.keys(COLOUR_HEX).join('|')})\\b` +
  `)`,
  'i'
)

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

/** "switch to opus" / "use gemini-2.5-pro": only for the model names the panel currently offers, so ordinary sentences are never taken for a switch. */
function modelPhrases(models: readonly string[]): [RegExp, RegExp] | null {
  const names = models.filter((m) => MODEL_NAME.test(m)).sort((a, b) => b.length - a.length).map(escapeRe)
  if (names.length === 0) return null
  const alt = names.join('|')
  return [
    new RegExp(`^(?:ok(?:ay)?,? |please |hey,? )?(?:switch|change|go|swap)(?: back)?(?: over)?(?: to)?(?: the)?(?: model)? (${alt})(?: model)?[.!]?$`, 'i'),
    new RegExp(`^(?:please )?use (?:the )?(${alt})(?: model)?(?: from now on| please)?[.!]?$`, 'i')
  ]
}

/** What to ask when the user just says "look at my screen" and nothing else. */
export const DEFAULT_LOOK_QUESTION = "What's on my screen right now? Describe it briefly and point out anything I should notice."
// "look at my screen" must be a request in its own right: the word after "screen" can only be punctuation, the end, or a
// connective such as "and"/"please"/"now". So "check the screen saver settings" is a normal message, not a capture.
const LOOK = /^(?:(?:hey|ok|okay|please|can you|could you|would you)[,]? )*(?:please )?(?:have a look at|take a look at|look at|check|examine|see|read) (?:my|the|this) screen(?=\s*$|\s*[,.!?;:]|\s+(?:and|then|please|now|right now|for me|to|so|because|-)\b)[\s,.:;-]*/i

/**
 * `/model <name>`, `/effort high`, `/new`, `/help`, plus the plain phrases "switch to <model>" / "use <model>" for the model
 * names in `models` (so it works by voice). Anything longer than a bare switch phrase is a normal message: "switch to opus
 * and explain X" goes to the assistant as written.
 */
export function parseCommand(text: string, models: readonly string[] = []): ChatCommand | null {
  const t = text.trim()
  if (t.startsWith('/')) {
    const [cmd = '', ...rest] = t.slice(1).split(/\s+/)
    const arg = rest.join(' ').trim()
    switch (cmd.toLowerCase()) {
      case 'model': {
        if (!arg) return { kind: 'bad', message: `Say which model: /model <name>${models.length ? ` (for example ${models.slice(0, 4).join(', ')})` : ''}.` }
        if (!MODEL_NAME.test(arg)) return { kind: 'bad', message: `"${arg.slice(0, 40)}" is not a model name.` }
        const known = models.find((m) => m.toLowerCase() === arg.toLowerCase())
        return { kind: 'model', model: known ?? arg }
      }
      case 'effort': {
        const e = arg.toLowerCase()
        if (!(EFFORTS as readonly string[]).includes(e)) return { kind: 'bad', message: `Effort is one of: ${EFFORTS.join(', ')}.` }
        return { kind: 'effort', effort: e }
      }
      case 'new':
      case 'clear':
        return { kind: 'new' }
      case 'screen':
      case 'look':
        return { kind: 'look', question: rest.join(' ').trim() || DEFAULT_LOOK_QUESTION }
      case 'pet':
        return { kind: 'pet', text: rest.join(' ').trim() }
      case 'help':
        return { kind: 'help' }
      default:
        return null // not ours (the mock has its own /slow, /fail...): send it on as a normal message
    }
  }
  const look = LOOK.exec(t)
  if (look) return { kind: 'look', question: t }
  if (t.length <= 600 && PET_REQUEST.test(t)) return { kind: 'pet', text: t }
  const phrases = modelPhrases(models)
  const m = phrases ? (phrases[0].exec(t) ?? phrases[1].exec(t)) : null
  if (!m) return null
  const named = m[1]!
  return { kind: 'model', model: models.find((x) => x.toLowerCase() === named.toLowerCase()) ?? named }
}

export const helpText = (models: readonly string[], canEffort: boolean): string =>
  `Commands: /model <name>${models.length ? ` (${models.slice(0, 5).join(', ')}...) or say "switch to ${models[0]}"` : ''}, ` +
  (canEffort ? `/effort <${EFFORTS.join('|')}>, ` : '') +
  '/pet <how to change your pet> (or just say "turn my pet into a mermaid"), /new for a fresh conversation, /screen <question> (or say "look at my screen") to share a screenshot with one message. ' +
  'Anything else goes to the assistant.'
