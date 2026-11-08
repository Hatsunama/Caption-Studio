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

/** Shared real RN fixture. Lifecycle and helpers only; concrete suites own all tests. */
public abstract class ReactNativeMinimumScaleTestSupport {
  private static final int INITIAL_PX = 30;
  protected static final int SPAN_FLAGS =
      Spanned.SPAN_EXCLUSIVE_EXCLUSIVE | (3 << Spanned.SPAN_PRIORITY_SHIFT);

  private DisplayMetrics oldWindow;
  private DisplayMetrics oldScreen;
  private boolean metricsInstalled;
  protected Class<? extends AbsoluteSizeSpan> rnSpanClass;
  private Constructor<? extends AbsoluteSizeSpan> spanConstructor;
  protected Method fitter;

  @Before public void setUp() throws Exception {
    assertEquals("SDK36 sandbox requires the verified Java21 test launcher", "21", System.getProperty("java.specification.version"));
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
