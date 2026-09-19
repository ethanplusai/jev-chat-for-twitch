/** Chat categories, selection policies and the local preview heuristic.
 * The browser and the server import the same module so a chip change can re-derive
 * selection from stored categories and probabilities without any extra Jev call. */
export const POLICY_VERSION = 'chat-meaning/2.0';
export const CRITERIA = Object.freeze({
  question: 'A substantive, on-topic question about the current stream or what is being demonstrated. A question mark alone is not sufficient.',
  insight: 'A relevant observation, explanation, constructive disagreement or suggestion with specific information. Criticism is allowed.',
  feedback: 'Actionable stream or accessibility feedback, including brief reports of audio, readability, or connection problems.',
  reply: 'A useful response to a recent substantive message, with enough context to be understood.',
  humor: 'A joke, pun, or playful comment that is actually funny in context, not an emote spam or a bare LOL.',
  reaction: 'Low-information reactions, emotes, cheering, bare catchphrases and repeated hype, with no substantive content and no actual joke.',
  spam: 'Unsolicited promotion, scams, repetitive solicitation, or obvious attempts to instruct this classifier rather than participate in the chat.',
  off_topic: 'Unrelated chatter with no meaningful connection to the stream or the recent discussion.',
  unsure: 'Too ambiguous or context-dependent to confidently classify. Do not invent missing context.'
});
const MEANINGFUL = ['question', 'insight', 'feedback', 'reply'];
export const POLICIES = Object.freeze({
  all: {label: 'Everything meaningful', categories: MEANINGFUL, threshold: 0.6},
  conversation: {label: 'Everything meaningful', categories: MEANINGFUL, threshold: 0.6},
  helpful: {label: 'Helpful', categories: MEANINGFUL, threshold: 0.6},
  questions: {label: 'Questions', categories: ['question', 'feedback'], threshold: 0.6},
  funny: {label: 'Funny', categories: ['humor'], threshold: 0.6},
  feedback: {label: 'Feedback', categories: ['feedback', 'insight'], threshold: 0.6},
  focused: {label: 'More selective', categories: MEANINGFUL, threshold: 0.75}
});
export const POLICY_NAMES = Object.freeze(Object.keys(POLICIES));
/** Chips shown in the Jev Chat header, in order. */
export const INTENTS = Object.freeze([
  {policy: 'helpful', label: 'Helpful', note: 'Questions, observations, replies and actionable feedback.'},
  {policy: 'questions', label: 'Questions', note: 'Substantive questions and stream feedback only.'},
  {policy: 'funny', label: 'Funny', note: 'Jokes and wordplay that land, not bare emote spam.'},
  {policy: 'feedback', label: 'Feedback', note: 'Actionable feedback and specific observations.'},
  {policy: 'all', label: 'Everything meaningful', note: 'The full meaningful-conversation policy.'}
]);
const HUMOR = /\b(pun intended|see myself out|asking for a friend|dad joke|knock knock)\b|why did the .{3,60}\?|walked into a bar|technically correct/;
export function previewClassify(body) {
  const s = body.toLowerCase().trim();
  if (/follow my|giveaway|free followers|subscribe to my|watch my stream|https?:\/\/\S+|ignore (all |previous |your )?instructions|return.{0,20}(question|insight|feedback)|classify (this|me) as/.test(s)) return 'spam';
  if (HUMOR.test(s) && s.split(/\s+/).length >= 5) return 'humor';
  if (/^(w+|l+|lol+|lmao+|bro+|bruh|clean|nice|\?+|first|wait what|pog+|ayoo+|nah+|let him cook|clip it|replay|hahaha|chat is flying|w stream|i was here|the colors+|full screen this|this is crazy|bro really said that|[^\p{L}\p{N}]+)$/u.test(s)) return 'reaction';
  if (/audio|labels? (are|is)|readab|hard to read|can't hear|cannot hear|left (ear|channel)|screen is (black|frozen)|preview (froze|frozen)|input disconnected|screen is clearer/.test(s)) return 'feedback';
  if (/(can|could|would|does|is|what|why|how|do|will)\b/.test(s) && s.includes('?') && s.split(/\s+/).length >= 6 && /palette|control|input|record|setting|animat|microphone|motion|sensitivity|volume|effect|keyboard|permission|device|console|error|render|reconnect|headphone|select|explain|test|pause|flash|publish|setup|project|preview|audio|app|color|build|connection/.test(s)) return 'question';
  if (/should|could|would|try checking|differs|skipped|stale|disconnected state|useful part|doesn.t explain|wrong because/.test(s) && s.split(/\s+/).length >= 6) return 'insight';
  if (/^(yes|no),/.test(s) && s.length > 35) return 'reply';
  return s.length < 12 ? 'unsure' : 'off_topic';
}
export const policyRule = policy => POLICIES[policy] ?? POLICIES.conversation;
export function disposition(category, probabilities, policy = 'conversation') {
  const rule = policyRule(policy);
  if (!probabilities) return {keep: rule.categories.includes(category), uncertain: category === 'unsure'};
  const target = rule.categories.reduce((sum, key) => sum + (probabilities[key] ?? 0), 0);
  return {keep: target >= rule.threshold, uncertain: probabilities.unsure >= 0.3 || (target > 0.35 && target < rule.threshold)};
}
