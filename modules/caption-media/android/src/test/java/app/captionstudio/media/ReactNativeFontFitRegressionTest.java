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

/** Candidate only: executes the dependency's RN fitter, with no RN or font-fitting shadows. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class ReactNativeFontFitRegressionTest {
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

  @Test public void nanMinimum_sharedText_sharedPaint_retains30px() throws Exception {
    checkAmple(Float.NaN, false, false);
  }

  @Test public void nanMinimum_sharedText_freshPaint_retains30px() throws Exception {
    checkAmple(Float.NaN, false, true);
  }

  @Test public void nanMinimum_freshText_freshPaint_retains30px() throws Exception {
    checkAmple(Float.NaN, true, true);
  }

  @Test public void explicit20_4Minimum_sharedText_sharedPaint_retains30px() throws Exception {
    checkAmple(20.4f, false, false);
  }

  @Test public void explicit20_4Minimum_sharedText_freshPaint_retains30px() throws Exception {
    checkAmple(20.4f, false, true);
  }

  @Test public void explicit20_4Minimum_freshText_freshPaint_retains30px() throws Exception {
    checkAmple(20.4f, true, true);
  }

  private void checkAmple(float minimum, boolean freshText, boolean freshPaint) throws Exception {
    List<String> failures = new ArrayList<>();
    SpannableString text = newText(LABEL);
    TextPaint paint = newPaint();
    assertInitiallyFits(text, paint);
    String scenario = "minimum=" + minimum + " freshText=" + freshText
        + " freshPaint=" + freshPaint;
    for (int call = 1; call <= CALLS; call++) {
      if (freshText) text = newText(LABEL);
      if (freshPaint) paint = newPaint();
      AbsoluteSizeSpan[] before = text.getSpans(0, text.length(), AbsoluteSizeSpan.class);
      String beforeSize = before.length == 1 ? Integer.toString(before[0].getSize()) : "invalid";
      float beforePaint = paint.getTextSize();
      fit(text, paint, 500f, 200f, minimum);
      AbsoluteSizeSpan[] after = text.getSpans(0, text.length(), AbsoluteSizeSpan.class);
      String prefix = scenario + " call=" + call;
      String details = " span=" + beforeSize + "->"
          + (after.length == 1 ? after[0].getSize() : "invalid")
          + " paint=" + beforePaint + "->" + paint.getTextSize()
          + " spanCount=" + after.length;
      if (after.length == 1) {
        AbsoluteSizeSpan span = after[0];
        details += " range=" + text.getSpanStart(span) + ":" + text.getSpanEnd(span)
            + " flags=" + text.getSpanFlags(span);
        if (span.getClass() != rnSpanClass || span.getSize() != INITIAL_PX || span.getDip()
            || text.getSpanStart(span) != 0 || text.getSpanEnd(span) != LABEL.length()
            || text.getSpanFlags(span) != SPAN_FLAGS) {
          failures.add(prefix + details);
        }
      } else {
        failures.add(prefix + details);
      }
      if (paint.getTextSize() != INITIAL_PX) failures.add(prefix + " paint=" + paint.getTextSize());
      if (!LABEL.equals(text.toString())) failures.add(prefix + " text=" + text);
      System.out.println("RN_FONTFIT " + prefix + details);
    }
    // Do not stop on call 1: all numeric observations must survive in captured stdout.
    assertTrue("Expected 30px and intact span metadata throughout " + scenario
        + "; failures:\n" + String.join("\n", failures), failures.isEmpty());
  }

  @Test public void tightSingleGlyph_invokesRealFitting() throws Exception {
    SpannableString text = newText("W");
    TextPaint paint = newPaint();
    float initialWidth = Layout.getDesiredWidth(text, paint);
    assertTrue("Control requires a real glyph wider than 1px: " + initialWidth, initialWidth > 1f);
    fit(text, paint, 1f, 200f, Float.NaN);
    AbsoluteSizeSpan[] spans = text.getSpans(0, text.length(), AbsoluteSizeSpan.class);
    assertEquals(1, spans.length);
    AbsoluteSizeSpan span = spans[0];
    System.out.println("RN_FONTFIT tightControl width=" + initialWidth + "->"
        + Layout.getDesiredWidth(text, paint) + " span=30->" + span.getSize()
        + " paint=30->" + paint.getTextSize());
    assertEquals(rnSpanClass, span.getClass());
    assertFalse(span.getDip());
    assertEquals(0, text.getSpanStart(span));
    assertEquals(1, text.getSpanEnd(span));
    assertEquals(SPAN_FLAGS, text.getSpanFlags(span));
    // NaN means 4dp = 12px at density 3. A 1px box is intentionally impossible
    // at this floor; the control verifies shrinkage, not successful containment.
    assertTrue("Fitter must shrink the actual RN span", span.getSize() >= 12 && span.getSize() < 30);
    assertTrue("Fitter must shrink paint", paint.getTextSize() >= 12f && paint.getTextSize() < 30f);
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

  private static void assertInitiallyFits(SpannableString text, TextPaint paint) {
    float width = Layout.getDesiredWidth(text, paint);
    StaticLayout layout = StaticLayout.Builder.obtain(text, 0, text.length(), paint, 500)
        .setAlignment(Layout.Alignment.ALIGN_NORMAL)
        .setIncludePad(false)
        .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
        .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
        .setUseLineSpacingFromFallbacks(true)
        .build();
    System.out.println("RN_FONTFIT precondition width=" + width + " height="
        + layout.getHeight() + " lines=" + layout.getLineCount());
    assertTrue("Expected real positive glyph width fitting 500px: " + width, width > 0 && width < 500);
    assertTrue("Expected positive text height fitting 200px", layout.getHeight() > 0 && layout.getHeight() < 200);
    assertEquals("Fixture must be one line at its original 30px", 1, layout.getLineCount());
  }

  private void fit(Spannable text, TextPaint paint, float width, float height, float minimum)
      throws Exception {
    try {
      fitter.invoke(null, text, width, YogaMeasureMode.EXACTLY,
          height, YogaMeasureMode.EXACTLY, minimum, 1, false,
          Layout.BREAK_STRATEGY_SIMPLE, Layout.HYPHENATION_FREQUENCY_NONE,
          Layout.Alignment.ALIGN_NORMAL, Layout.JUSTIFICATION_MODE_NONE, paint);
    } catch (InvocationTargetException invocation) {
      // Preserve native/linkage/classloading failures as failures; never skip or mock them away.
      Throwable cause = invocation.getCause();
      if (cause instanceof Error) throw (Error) cause;
      if (cause instanceof Exception) throw (Exception) cause;
      throw new AssertionError("RN fitter invocation failed", cause);
    }
  }
}
