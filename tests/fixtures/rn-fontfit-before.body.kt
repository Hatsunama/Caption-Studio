
    var boring = isBoring(text, paint)
    var layout: Layout

    // Minimum font size is 4pts to match the iOS implementation.
    val minimumFontSize =
        (if (minimumFontSizeAttr.isNaN()) 4.dpToPx() else minimumFontSizeAttr).toInt()

    // Find the largest font size used in the spannable to use as a starting point.
    var currentFontSize = minimumFontSize
    val spans = text.getSpans(0, text.length, ReactAbsoluteSizeSpan::class.java)
    for (span in spans) {
      currentFontSize = max(currentFontSize, span.size).toInt()
    }

    var intervalStart = minimumFontSize
    var intervalEnd = currentFontSize
    var previousFontSize = currentFontSize

    // `true` instead of `intervalStart != intervalEnd` so that the last iteration where both are at
    // the same size goes through and updates all relevant objects with the final font size
    while (true) {
      // Always use the point closer to the end of the interval, this way at the end when
      // end - start == 1, we land at current = end instead of current = start. In the first case
      // one measurement may be enough if intervalEnd is small enough to fit. In the second case
      // we always end up doing two measurements to check whether intervalEnd would fit.
      val currentFontSize = (intervalStart + intervalEnd + 1) / 2

      val ratio = currentFontSize.toFloat() / previousFontSize.toFloat()
      paint.textSize = max((paint.textSize * ratio).toInt(), minimumFontSize).toFloat()

      val sizeSpans = text.getSpans(0, text.length, ReactAbsoluteSizeSpan::class.java)
      for (span in sizeSpans) {
        text.setSpan(
            ReactAbsoluteSizeSpan(max((span.size * ratio).toInt(), minimumFontSize)),
            text.getSpanStart(span),
            text.getSpanEnd(span),
            text.getSpanFlags(span),
        )
        text.removeSpan(span)
      }
      if (boring != null) {
        boring = isBoring(text, paint)
      }
      layout =
          createLayout(
              text,
              boring,
              width,
              widthYogaMeasureMode,
              includeFontPadding,
              textBreakStrategy,
              hyphenationFrequency,
              alignment,
              justificationMode,
              null,
              ReactConstants.UNSET,
              paint,
          )

      if (intervalStart == intervalEnd) {
        // everything is updated at this point
        break
      }

      val singleLineTextExceedsWidth = text.length == 1 && layout.getLineWidth(0) > width
      val exceedsHeight =
          heightYogaMeasureMode != YogaMeasureMode.UNDEFINED && layout.height > height
      val exceedsMaximumNumberOfLines =
          maximumNumberOfLines != ReactConstants.UNSET &&
              maximumNumberOfLines != 0 &&
              layout.lineCount > maximumNumberOfLines

      if (
          currentFontSize > minimumFontSize &&
              (exceedsMaximumNumberOfLines || exceedsHeight || singleLineTextExceedsWidth)
      ) {
        // Text doesn't fit the constraints. If intervalEnd - intervalStart == 1, it's known that
        // the correct font size is intervalStart. Set intervalEnd to match intervalStart and do one
        // more iteration to update layout correctly.
        intervalEnd = if (intervalEnd - intervalStart == 1) intervalStart else currentFontSize
      } else {
        // Text fits the constraints
        intervalStart = currentFontSize
      }

      previousFontSize = currentFontSize
    }