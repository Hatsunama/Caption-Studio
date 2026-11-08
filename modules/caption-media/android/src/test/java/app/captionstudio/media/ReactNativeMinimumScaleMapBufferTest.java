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
import java.lang.reflect.Field;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

/** Candidate only: executes the dependency's RN fitter, with no RN or font-fitting shadows. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36, manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class ReactNativeMinimumScaleMapBufferTest {
  private static final int INITIAL_PX = 30;
  private static final int SPAN_FLAGS =
      Spanned.SPAN_EXCLUSIVE_EXCLUSIVE | (3 << Spanned.SPAN_PRIORITY_SHIFT);

  private DisplayMetrics oldWindow;
  private DisplayMetrics oldScreen;
  private boolean metricsInstalled;
  private Class<? extends AbsoluteSizeSpan> rnSpanClass;
  private Constructor<? extends AbsoluteSizeSpan> spanConstructor;
  protected Method fitter;

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


  // FIRST RED: this compiles against the CURRENT dependency: no new constant or overload referenced.
  @Test public void literalKey10_reachesActualCreateLayout_floorIsLiteral20px() throws Exception {
    int observed = layoutSize(0.68, Double.NaN, 1f, true);
    System.out.println("RN_MINSCALE observed=" + observed + " expected=20 initial=30 scale=.68");
    assertEquals("Literal key 10 must impose 20px floor; old code is expected below 20", 20, observed);
  }

  @Test public void absentZeroNegativeNaNScale_keepLegacy12pxFloor() throws Exception {
    assertEquals(12, layoutSize(null, Double.NaN, 1f, true));
    assertEquals(12, layoutSize(0.0, Double.NaN, 1f, true));
    assertEquals(12, layoutSize(-0.5, Double.NaN, 1f, true));
    assertEquals(12, layoutSize(Double.NaN, Double.NaN, 1f, true));
    assertEquals(12, layoutSize(0.01, Double.NaN, 1f, true));
  }

  @Test public void explicitAbsoluteIncludingZero_winsOverScale() throws Exception {
    assertEquals(16, layoutSize(0.68, 16.9, 1f, true));
    assertEquals(0, layoutSize(0.68, 0.0, 0f, true));
  }

  @Test public void fitsOrAdjustmentDisabled_preserves30px() throws Exception {
    assertEquals(30, layoutSize(0.68, Double.NaN, 200f, true));
    assertEquals(30, layoutSize(0.68, Double.NaN, 1f, false));
  }

  @Test public void old13ArgumentABI_stillUsesAbsoluteAndLegacyNaN() throws Exception {
    assertEquals(12, oldFit(Float.NaN));
    assertEquals(20, oldFit(20.4f));
  }

  private int oldFit(float minimum) throws Exception {
    SpannableString text = newText("W");
    invoke(fitter, null, text, 10000f, YogaMeasureMode.EXACTLY,
        1f, YogaMeasureMode.EXACTLY, minimum, 1, false,
        Layout.BREAK_STRATEGY_SIMPLE, Layout.HYPHENATION_FREQUENCY_NONE,
        Layout.Alignment.ALIGN_NORMAL, Layout.JUSTIFICATION_MODE_NONE, newPaint());
    return text.getSpans(0, text.length(), AbsoluteSizeSpan.class)[0].getSize();
  }

  private int layoutSize(Double scale, double absolute, float height, boolean adjust) throws Exception {
    Class<?> mapClass = Class.forName("com.facebook.react.common.mapbuffer.MapBuffer");
    Class<?> writable = Class.forName("com.facebook.react.common.mapbuffer.WritableMapBuffer");
    Constructor<?> ctor = writable.getDeclaredConstructor();
    ctor.setAccessible(true);
    Object paragraph = ctor.newInstance();
    put(writable, paragraph, 0, int.class, 1);
    put(writable, paragraph, 2, String.class, "simple");
    put(writable, paragraph, 3, boolean.class, adjust);
    put(writable, paragraph, 4, boolean.class, false);
    put(writable, paragraph, 5, String.class, "none");
    put(writable, paragraph, 6, double.class, absolute);
    if (scale != null) put(writable, paragraph, 10, double.class, scale);
    Object attributed = ctor.newInstance(); // missing fragments is explicitly supported by RN alignment readers
    SpannableString text = newText("W");
    TextPaint paint = newPaint();
    assertTrue("Real SDK glyph precondition", Layout.getDesiredWidth(text, paint) > 1f);
    StaticLayout control = StaticLayout.Builder.obtain(text, 0, text.length(), paint, 10000)
        .setIncludePad(false).build();
    assertTrue("Impossible-height fixture requires real metrics", control.getHeight() > 1);
    Class<?> manager = fitter.getDeclaringClass();
    Method create = manager.getDeclaredMethod("createLayout", Spannable.class, TextPaint.class,
        mapClass, mapClass, float.class, YogaMeasureMode.class, float.class, YogaMeasureMode.class);
    create.setAccessible(true);
    Object receiver = null;
    if (!Modifier.isStatic(create.getModifiers())) {
      Field instance = manager.getDeclaredField("INSTANCE");
      instance.setAccessible(true);
      receiver = instance.get(null);
    }
    System.out.println("RN_MINSCALE realCreateLayout=" + create.toGenericString()
        + " map=" + writable.getResource("WritableMapBuffer.class"));
    Object result = invoke(create, receiver, text, paint, attributed, paragraph,
        10000f, YogaMeasureMode.EXACTLY, height, YogaMeasureMode.EXACTLY);
    assertNotNull(result);
    AbsoluteSizeSpan[] spans = text.getSpans(0, text.length(), AbsoluteSizeSpan.class);
    assertEquals(1, spans.length);
    assertEquals(rnSpanClass, spans[0].getClass());
    assertEquals(0, text.getSpanStart(spans[0]));
    assertEquals(1, text.getSpanEnd(spans[0]));
    assertEquals(SPAN_FLAGS, text.getSpanFlags(spans[0]));
    return spans[0].getSize();
  }

  protected static void put(Class<?> writable, Object map, int key, Class<?> type, Object value)
      throws Exception {
    Method method = writable.getDeclaredMethod("put", int.class, type);
    method.setAccessible(true);
    invoke(method, map, key, value);
  }

  protected static Object invoke(Method method, Object receiver, Object... args) throws Exception {
    try { return method.invoke(receiver, args); }
    catch (InvocationTargetException invocation) {
      Throwable cause = invocation.getCause();
      if (cause instanceof Error) throw (Error) cause;
      if (cause instanceof Exception) throw (Exception) cause;
      throw new AssertionError("RN invocation failed: harness gap, not behavioral RED", cause);
    }
  }
  protected SpannableString newText(String value) throws Exception {
    SpannableString text = new SpannableString(value);
    text.setSpan(spanConstructor.newInstance(INITIAL_PX), 0, text.length(), SPAN_FLAGS);
    return text;
  }

  protected static TextPaint newPaint() {
    TextPaint paint = new TextPaint(TextPaint.ANTI_ALIAS_FLAG);
    paint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
    paint.setTextSize(INITIAL_PX);
    paint.density = 3f;
    return paint;
  }

}
