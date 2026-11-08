package app.captionstudio.media;

import static org.junit.Assert.*;

import android.graphics.Typeface;
import android.text.Layout;
import android.text.Spannable;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.style.AbsoluteSizeSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;
import android.util.DisplayMetrics;
import com.facebook.react.uimanager.DisplayMetricsHolder;
import com.facebook.yoga.YogaMeasureMode;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

/** Additional candidate: real RN invocation; exhaustive Android-layout oracle, no search copy. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class ReactNativeFontFitAdditionalRegressionTest {
  private static final int INITIAL_PX = 30;
  private static final int CALLS = 20;
  private static final String LABEL = "Toolbar";
  private static final int SPAN_FLAGS =
      Spanned.SPAN_EXCLUSIVE_EXCLUSIVE | (3 << Spanned.SPAN_PRIORITY_SHIFT);

  private DisplayMetrics oldWindow;
  private DisplayMetrics oldScreen;
  private boolean metricsInstalled;
  private Class<? extends AbsoluteSizeSpan> rnSpanClass;
  private Constructor<? extends AbsoluteSizeSpan> spanConstructor;
  private Method fitter;

  @Before public void setUp() throws Exception {
    // Public RN getters require initialization. Preserve null when previously uninitialized.
    try { oldWindow = DisplayMetricsHolder.getWindowDisplayMetrics(); }
    catch (IllegalStateException uninitialized) { oldWindow = null; }
    try { oldScreen = DisplayMetricsHolder.getScreenDisplayMetrics(); }
    catch (IllegalStateException uninitialized) { oldScreen = null; }
    DisplayMetrics metrics = new DisplayMetrics();
    metrics.setToDefaults();
    metrics.density = 3f;
    metrics.scaledDensity = 3f;
    metrics.densityDpi = 480;
    metrics.widthPixels = 1080;
    metrics.heightPixels = 2400;
    DisplayMetricsHolder.setWindowDisplayMetrics(metrics);
    DisplayMetricsHolder.setScreenDisplayMetrics(metrics);
    metricsInstalled = true;
    assertEquals(3f, DisplayMetricsHolder.getScreenDisplayMetrics().density, 0f);
    assertEquals(3f, DisplayMetricsHolder.getWindowDisplayMetrics().scaledDensity, 0f);

    // Kotlin internal classes are accessed by reflection; no copied RN source is compiled.
    ClassLoader loader = getClass().getClassLoader();
    rnSpanClass = Class.forName(
        "com.facebook.react.views.text.internal.span.ReactAbsoluteSizeSpan", true, loader)
        .asSubclass(AbsoluteSizeSpan.class);
    spanConstructor = rnSpanClass.getDeclaredConstructor(int.class);
    spanConstructor.setAccessible(true);
    Class<?> manager = Class.forName(
        "com.facebook.react.views.text.TextLayoutManager", true, loader);
    fitter = manager.getDeclaredMethod("adjustSpannableFontToFit",
        Spannable.class, float.class, YogaMeasureMode.class,
        float.class, YogaMeasureMode.class, float.class, int.class,
        boolean.class, int.class, int.class, Layout.Alignment.class,
        int.class, TextPaint.class);
    fitter.setAccessible(true);
    assertTrue("Expected actual @JvmStatic RN entry point", Modifier.isStatic(fitter.getModifiers()));
    assertEquals(void.class, fitter.getReturnType());
    System.out.println("RN_FITTER signature=" + fitter.toGenericString()
        + " loader=" + manager.getClassLoader()
        + " resource=" + manager.getResource("TextLayoutManager.class")
        + " codeSource=" + manager.getProtectionDomain().getCodeSource());
  }

  @After public void tearDown() {
    if (metricsInstalled) {
      DisplayMetricsHolder.setWindowDisplayMetrics(oldWindow);
      DisplayMetricsHolder.setScreenDisplayMetrics(oldScreen);
    }
  }


  @Test public void mixedSizes_ample_basePaintLarger_preservesFractionAndMetadata() throws Exception {
    assertAmpleMixed(47.25f);
  }

  @Test public void mixedSizes_ample_basePaintSmaller_preservesFractionAndMetadata() throws Exception {
    assertAmpleMixed(21.75f);
  }

  private void assertAmpleMixed(float baseSize) throws Exception {
    SpannableString text = mixedText();
    TextPaint paint = newPaint();
    paint.setTextSize(baseSize);
    Snapshot original = new Snapshot(text, paint);
    Object marker = text.getSpans(0, text.length(), ForegroundColorSpan.class)[0];
    for (int call = 0; call < CALLS; call++) {
      invokeFit(text, paint, 2000, 2000, Float.NaN, 2, YogaMeasureMode.EXACTLY);
      assertResult(original, text, paint, 30, 12);
      assertEquals(5, text.getSpanStart(marker));
      assertEquals(10, text.getSpanEnd(marker));
      assertEquals(Spanned.SPAN_EXCLUSIVE_EXCLUSIVE, text.getSpanFlags(marker));
    }
  }

  @Test public void basePaintBelowExplicitMinimum_ampleLayoutStillClampsPaint() throws Exception {
    SpannableString text = newText("Toolbar");
    TextPaint paint = newPaint();
    paint.setTextSize(17.25f);
    Snapshot original = new Snapshot(text, paint);
    for (int call = 0; call < CALLS; call++) {
      invokeFit(text, paint, 2000, 2000, 20.4f, 1, YogaMeasureMode.EXACTLY);
      // Explicit 20.4 is truncated to 20px. Ample space does not bypass this clamp.
      assertResult(original, text, paint, 30, 20);
      assertEquals(20f, paint.getTextSize(), 0f);
    }
  }

  @Test public void equalPriorityOverlaps_preserveReplacementOrderAndFlags() throws Exception {
    SpannableString text = new SpannableString("Toolbar");
    text.setSpan(spanConstructor.newInstance(30), 0, 7, SPAN_FLAGS);
    text.setSpan(spanConstructor.newInstance(23), 0, 7, SPAN_FLAGS);
    TextPaint paint = newPaint();
    paint.setTextSize(41.5f);
    Snapshot original = new Snapshot(text, paint);
    for (int call = 0; call < CALLS; call++) {
      invokeFit(text, paint, 2000, 2000, Float.NaN, 1, YogaMeasureMode.EXACTLY);
      assertResult(original, text, paint, 30, 12);
    }
  }

  @Test public void mixedSizes_widthAndLineLimit_matchesExhaustiveAndroidOracle() throws Exception {
    checkMixedWidth(Float.NaN, 12);
  }

  @Test public void mixedSizes_heightLimit_matchesExhaustiveAndroidOracle() throws Exception {
    SpannableString text = mixedText();
    TextPaint paint = newPaint();
    paint.setTextSize(47.25f);
    Snapshot snapshot = new Snapshot(text, paint);
    int height = androidLayout(snapshot, 22, 12, 2000).getHeight();
    checkConstrained(text, 47.25f, 2000, height, Float.NaN, 2,
        YogaMeasureMode.EXACTLY);
  }

  @Test public void mixedSizes_explicitFractionalMinimum_clampsSmallerRuns() throws Exception {
    checkMixedWidth(20.4f, 20);
  }

  @Test public void ordinaryWords_undefinedHeight_lineLimitStillFits() throws Exception {
    SpannableString text = newText("ordinary words wrap neatly");
    Snapshot original = new Snapshot(text, newPaint());
    int width = (int) Math.ceil(Layout.getDesiredWidth(
        oracleText(original, 22, 12), oraclePaint(original, 22, 12)));
    checkConstrained(text, 30f, width, 0, Float.NaN, 1, YogaMeasureMode.UNDEFINED);
  }

  @Test public void singleGlyph_feasibleWidth_selectsLargestFittingSize() throws Exception {
    SpannableString text = newText("W");
    TextPaint paint = newPaint();
    Snapshot snapshot = new Snapshot(text, paint);
    SpannableString trial = oracleText(snapshot, 23, 12);
    TextPaint trialPaint = oraclePaint(snapshot, 23, 12);
    int width = (int) Math.ceil(Layout.getDesiredWidth(trial, trialPaint));
    checkConstrained(text, 30f, width, 2000, Float.NaN, 1, YogaMeasureMode.EXACTLY);
  }

  @Test public void legitimatelyShrunkInput_ampleCallPreservesCurrentSizesOnly() throws Exception {
    SpannableString text = newText("W");
    TextPaint paint = newPaint();
    invokeFit(text, paint, 1, 2000, Float.NaN, 1, YogaMeasureMode.EXACTLY);
    Snapshot shrunk = new Snapshot(text, paint);
    assertTrue(shrunk.sizes[0] < 30);
    invokeFit(text, paint, 2000, 2000, Float.NaN, 1, YogaMeasureMode.EXACTLY);
    assertResult(shrunk, text, paint, shrunk.largest, 12);
  }

  @Test public void noRnSizeSpans_preservesBasePaintAndUnrelatedAbsoluteSize() throws Exception {
    SpannableString text = new SpannableString("Toolbar");
    AbsoluteSizeSpan unrelated = new AbsoluteSizeSpan(25);
    text.setSpan(unrelated, 0, text.length(), SPAN_FLAGS);
    TextPaint paint = newPaint();
    paint.setTextSize(37.25f);
    invokeFit(text, paint, 2000, 2000, Float.NaN, 1, YogaMeasureMode.EXACTLY);
    assertEquals(37.25f, paint.getTextSize(), 0f);
    assertEquals(0, text.getSpans(0, text.length(), rnSpanClass).length);
    assertSame(unrelated, text.getSpans(0, text.length(), AbsoluteSizeSpan.class)[0]);
    assertEquals(25, unrelated.getSize());
    assertEquals(SPAN_FLAGS, text.getSpanFlags(unrelated));
  }

  private void checkMixedWidth(float minimum, int floor) throws Exception {
    SpannableString text = mixedText();
    TextPaint paint = newPaint();
    paint.setTextSize(47.25f);
    Snapshot original = new Snapshot(text, paint);
    int width = (int) Math.ceil(Layout.getDesiredWidth(
        oracleText(original, 22, floor), oraclePaint(original, 22, floor)));
    checkConstrained(text, 47.25f, width, 2000, minimum, 2, YogaMeasureMode.EXACTLY);
  }

  private SpannableString mixedText() throws Exception {
    SpannableString text = new SpannableString("WIDE words\nwrap neatly");
    text.setSpan(spanConstructor.newInstance(30), 0, 4, SPAN_FLAGS);
    text.setSpan(spanConstructor.newInstance(23), 5, 10,
        Spanned.SPAN_INCLUSIVE_EXCLUSIVE | (2 << Spanned.SPAN_PRIORITY_SHIFT));
    text.setSpan(spanConstructor.newInstance(17), 11, text.length(),
        Spanned.SPAN_EXCLUSIVE_INCLUSIVE | (1 << Spanned.SPAN_PRIORITY_SHIFT));
    text.setSpan(new ForegroundColorSpan(0xff123456), 5, 10, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    text.setSpan(new StyleSpan(Typeface.BOLD), 11, text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    return text;
  }

  private void checkConstrained(SpannableString text, float baseSize, int width, int height,
      float minimum, int maxLines, YogaMeasureMode heightMode) throws Exception {
    TextPaint paint = newPaint();
    paint.setTextSize(baseSize);
    Snapshot original = new Snapshot(text, paint);
    int floor = Float.isNaN(minimum) ? 12 : (int) minimum;
    // Enumerate the whole small integer domain using fresh Android spans/layouts.
    // This intentionally shares no RN binary-search implementation or layout helper.
    assertFalse("Fixture must require shrinkage",
        oracleFits(original, original.largest, floor, width, height, maxLines, heightMode));
    assertTrue("Fixture must be feasible at the floor",
        oracleFits(original, floor, floor, width, height, maxLines, heightMode));
    int expected = floor;
    for (int size = floor; size <= original.largest; size++) {
      if (oracleFits(original, size, floor, width, height, maxLines, heightMode)) expected = size;
    }
    assertTrue(expected < original.largest);
    invokeFit(text, paint, width, height, minimum, maxLines, heightMode);
    assertResult(original, text, paint, expected, floor);
    StaticLayout actual = platformLayout(text, paint, width);
    assertTrue(actual.getLineCount() <= maxLines);
    if (heightMode != YogaMeasureMode.UNDEFINED) assertTrue(actual.getHeight() <= height);
    if (text.length() == 1) assertTrue(actual.getLineWidth(0) <= width);
    System.out.println("RN_FONTFIT_ORACLE width=" + width + " height=" + height
        + " floor=" + floor + " expected=" + expected + " paint=" + paint.getTextSize());
  }

  private static final class Snapshot {
    final SpannableString text;
    final TextPaint paint;
    final AbsoluteSizeSpan[] spans;
    final int[] sizes, starts, ends, flags;
    final int largest;
    Snapshot(SpannableString value, TextPaint base) {
      text = new SpannableString(value);
      paint = new TextPaint(base);
      spans = value.getSpans(0, value.length(), AbsoluteSizeSpan.class);
      sizes = new int[spans.length]; starts = new int[spans.length];
      ends = new int[spans.length]; flags = new int[spans.length];
      int largestSize = 12;
      for (int i = 0; i < spans.length; i++) {
        sizes[i] = spans[i].getSize(); largestSize = Math.max(largestSize, sizes[i]);
        starts[i] = value.getSpanStart(spans[i]); ends[i] = value.getSpanEnd(spans[i]);
        flags[i] = value.getSpanFlags(spans[i]);
      }
      largest = largestSize;
    }
  }

  private static SpannableString oracleText(Snapshot original, int size, int floor) {
    SpannableString text = new SpannableString(original.text);
    for (AbsoluteSizeSpan span : original.spans) text.removeSpan(span);
    float scale = (float) size / original.largest;
    for (int i = 0; i < original.spans.length; i++) {
      // Android's public span gives an independent layout oracle; RN is only invoked as the SUT.
      text.setSpan(new AbsoluteSizeSpan(Math.max(floor, (int) (original.sizes[i] * scale))),
          original.starts[i], original.ends[i], original.flags[i]);
    }
    return text;
  }

  private static TextPaint oraclePaint(Snapshot original, int size, int floor) {
    TextPaint paint = new TextPaint(original.paint);
    paint.setTextSize(Math.max(floor, original.paint.getTextSize() * ((float) size / original.largest)));
    return paint;
  }

  private static StaticLayout platformLayout(Spannable text, TextPaint paint, int width) {
    return StaticLayout.Builder.obtain(text, 0, text.length(), paint, width)
        .setAlignment(Layout.Alignment.ALIGN_NORMAL).setLineSpacing(0f, 1f)
        .setIncludePad(false).setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
        .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
        .setJustificationMode(Layout.JUSTIFICATION_MODE_NONE)
        .setUseLineSpacingFromFallbacks(true).build();
  }

  private static StaticLayout androidLayout(Snapshot original, int size, int floor, int width) {
    return platformLayout(oracleText(original, size, floor), oraclePaint(original, size, floor), width);
  }

  private static boolean oracleFits(Snapshot original, int size, int floor, int width, int height,
      int maxLines, YogaMeasureMode heightMode) {
    StaticLayout layout = androidLayout(original, size, floor, width);
    return layout.getLineCount() <= maxLines
        && (heightMode == YogaMeasureMode.UNDEFINED || layout.getHeight() <= height)
        && (original.text.length() != 1 || layout.getLineWidth(0) <= width);
  }

  private void assertResult(Snapshot original, SpannableString text, TextPaint paint,
      int expected, int floor) {
    AbsoluteSizeSpan[] spans = text.getSpans(0, text.length(), AbsoluteSizeSpan.class);
    assertEquals(original.spans.length, spans.length);
    float scale = (float) expected / original.largest;
    for (int i = 0; i < spans.length; i++) {
      assertEquals(rnSpanClass, spans[i].getClass());
      assertFalse(spans[i].getDip());
      assertEquals("size at index " + i, Math.max(floor, (int) (original.sizes[i] * scale)),
          spans[i].getSize());
      assertEquals(original.starts[i], text.getSpanStart(spans[i]));
      assertEquals(original.ends[i], text.getSpanEnd(spans[i]));
      assertEquals(original.flags[i], text.getSpanFlags(spans[i]));
    }
    assertEquals(Math.max(floor, original.paint.getTextSize() * scale), paint.getTextSize(), 0.0001f);
    assertEquals(original.text.toString(), text.toString());
    assertSame(original.paint.getTypeface(), paint.getTypeface());
    assertEquals(original.paint.getFlags(), paint.getFlags());
    assertEquals(original.paint.density, paint.density, 0f);
    assertEquals(original.paint.getTextScaleX(), paint.getTextScaleX(), 0f);
    assertEquals(original.paint.getTextSkewX(), paint.getTextSkewX(), 0f);
    StyleSpan[] styles = original.text.getSpans(0, text.length(), StyleSpan.class);
    for (StyleSpan style : styles) {
      assertEquals(original.text.getSpanStart(style), text.getSpanStart(style));
      assertEquals(original.text.getSpanEnd(style), text.getSpanEnd(style));
      assertEquals(original.text.getSpanFlags(style), text.getSpanFlags(style));
    }
  }

  private SpannableString newText(String value) throws Exception {
    SpannableString text = new SpannableString(value);
    text.setSpan(spanConstructor.newInstance(INITIAL_PX), 0, text.length(), SPAN_FLAGS);
    return text;
  }

  private static TextPaint newPaint() {
    TextPaint paint = new TextPaint(TextPaint.ANTI_ALIAS_FLAG);
    paint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
    paint.setTextSize(INITIAL_PX);
    paint.density = 3f;
    return paint;
  }

  private void invokeFit(Spannable text, TextPaint paint, float width, float height, float minimum,
      int maxLines, YogaMeasureMode heightMode) throws Exception {
    try {
      fitter.invoke(null, text, width, YogaMeasureMode.EXACTLY,
          height, heightMode, minimum, maxLines, false,
          Layout.BREAK_STRATEGY_SIMPLE, Layout.HYPHENATION_FREQUENCY_NONE,
          Layout.Alignment.ALIGN_NORMAL, Layout.JUSTIFICATION_MODE_NONE, paint);
    } catch (InvocationTargetException invocation) {
      Throwable cause = invocation.getCause();
      if (cause instanceof Error) throw (Error) cause;
      if (cause instanceof Exception) throw (Exception) cause;
      throw new AssertionError("RN fitter invocation failed", cause);
    }
  }
}
