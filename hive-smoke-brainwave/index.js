/**
 * Reverses the order of words in a sentence while preserving single spaces.
 * @param {string} sentence - The input sentence.
 * @returns {string} - The sentence with reversed word order.
 */
export function reverseWords(sentence) {
  if (!sentence) return '';
  return sentence.split(' ').reverse().join(' ');
}
