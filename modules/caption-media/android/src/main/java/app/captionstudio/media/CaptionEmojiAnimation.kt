package app.captionstudio.media

/** Derive a single cycle from live cue bounds, never from preset or word duration. */
internal fun captionCueProgress(currentMs: Long, startMs: Long, endMs: Long): Float? {
  if (endMs <= startMs || currentMs < startMs || currentMs >= endMs) return null
  return (currentMs - startMs).toFloat() / (endMs - startMs).toFloat()
}

internal fun captionCueEmojis(catalog: EmojiReactionCatalog, text: String): List<String> {
  val words = CaptionTextBreaks.tokens(java.text.Normalizer.normalize(text, java.text.Normalizer.Form.NFC))
  words.forEachIndexed { index, word ->
    val emojis = catalog.resolve(word, text, words, index)
    if (emojis.isNotEmpty()) return emojis.take(2)
  }
  return catalog.resolve("", text).take(2)
}
