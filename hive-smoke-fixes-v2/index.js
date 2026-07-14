/**
 * Slugifies a given string by:
 * 1. Converting to lowercase.
 * 2. Trimming whitespace.
 * 3. Replacing runs of non-alphanumeric characters with single hyphens.
 * 4. Removing leading and trailing hyphens.
 *
 * @param {string} text - The text to slugify.
 * @returns {string} The slugified string.
 */
export function slugify(text) {
  if (typeof text !== 'string') {
    return '';
  }

  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric characters with hyphens
    .replace(/^-+|-+$/g, '');    // Remove leading and trailing hyphens
}
