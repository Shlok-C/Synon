/**
 * Common / stop words that Exact Mode OFF will silently skip.
 * Covers articles, prepositions, pronouns, common verbs, conjunctions,
 * adverbs, and number words.
 */
export const COMMON_WORDS: ReadonlySet<string> = new Set([
  // Articles
  "a", "an", "the",

  // Prepositions
  "about", "above", "across", "after", "against", "along", "among", "around",
  "at", "before", "behind", "below", "beneath", "beside", "between", "beyond",
  "by", "down", "during", "except", "for", "from", "in", "inside", "into",
  "like", "near", "of", "off", "on", "onto", "out", "outside", "over", "past",
  "since", "through", "throughout", "to", "toward", "towards", "under",
  "underneath", "until", "up", "upon", "with", "within", "without",

  // Pronouns
  "i", "me", "my", "mine", "myself",
  "you", "your", "yours", "yourself", "yourselves",
  "he", "him", "his", "himself",
  "she", "her", "hers", "herself",
  "it", "its", "itself",
  "we", "us", "our", "ours", "ourselves",
  "they", "them", "their", "theirs", "themselves",
  "this", "that", "these", "those",
  "who", "whom", "whose", "which", "what",
  "all", "each", "every", "both", "few", "more", "most", "other", "some",
  "any", "no", "not", "only", "own", "same", "so", "than", "too", "very",
  "such", "none", "one", "ones",

  // Common verbs / auxiliaries
  "am", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having",
  "do", "does", "did", "doing", "done",
  "will", "would", "shall", "should", "may", "might", "must", "can", "could",
  "get", "got", "gets", "go", "goes", "went", "gone",
  "make", "made", "take", "took", "taken",
  "come", "came", "say", "said", "see", "saw", "seen",
  "know", "knew", "known", "think", "thought",
  "give", "gave", "given", "tell", "told",
  "let", "put", "set", "keep", "kept",

  // Conjunctions
  "and", "but", "or", "nor", "for", "yet", "so",
  "because", "although", "though", "while", "if", "then", "else",
  "when", "where", "how", "why",

  // Common adverbs
  "also", "just", "now", "here", "there", "then", "still", "already",
  "always", "never", "often", "sometimes", "usually", "again",
  "even", "well", "back", "much", "many", "really", "right",
  "quite", "almost", "enough", "ever", "perhaps", "maybe",
  "yes", "no", "not", "just", "also", "very", "often", "however",

  // Number words (zero through billion, ordinals first-third)
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty",
  "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand",
  "million", "billion",
  "first", "second", "third",

  // Other extremely common words
  "as", "at", "but", "by", "if", "or", "no", "so", "to", "up",
  "new", "old", "big", "good", "bad", "long", "great", "little", "own",
  "next", "last", "over", "way", "time", "day", "year", "part",
]);

export function isCommonWord(text: string): boolean {
  return COMMON_WORDS.has(text.toLowerCase());
}
