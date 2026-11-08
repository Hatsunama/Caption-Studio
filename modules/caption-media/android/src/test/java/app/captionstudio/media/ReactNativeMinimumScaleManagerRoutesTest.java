package app.captionstudio.media;

import static org.junit.Assert.*;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.text.Layout;
import android.text.Spannable;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.style.AbsoluteSizeSpan;
import android.util.TypedValue;
import android.view.ContextThemeWrapper;
import com.facebook.react.bridge.JavaOnlyMap;
import com.facebook.yoga.YogaMeasureMode;
import com.facebook.react.uimanager.ReactStylesDiffMap;
import com.facebook.react.views.text.ReactTextView;
import com.facebook.react.views.text.ReactTextViewManager;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.lang.reflect.Method;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

/** GREEN-phase candidate coverage: real manager methods, real view and real draw. No RN shadows. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36, manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class ReactNativeMinimumScaleManagerRoutesTest extends ReactNativeMinimumScaleTestSupport {
  @Test public void preparedAndFallback_deliverScale_resetNaN_andAbsolutePrecedence() throws Exception {
    route(false, Double.NaN, 0.68, 20);
    route(true, Double.NaN, 0.68, 20);
    route(false, 16.9, 0.68, 16);
    route(true, 16.9, 0.68, 16);
  }

  private void route(boolean prepared, double absolute, double scale, int expected) throws Exception {
    ReactTextView view = newView();
    ReactTextViewManager manager = new ReactTextViewManager();
    // Same instance receives a configured value and an unset update; stale scale must not survive.
    bind(manager, view, prepared, absolute, scale);
    drawAndAssert(view, expected);
    bind(manager, view, prepared, Double.NaN, null);
    drawAndAssert(view, 12);
  }

  private void bind(ReactTextViewManager manager, ReactTextView view, boolean prepared,
      double absolute, Double scale) throws Exception {
    Object update;
    if (prepared) {
      // Transfer the actual private createLayout result, never a raw-30 fabricated layout.
      Object measured = measure(absolute, scale, 1f);
      update = preparedUpdate(manager, view, measured);
    } else {
      SpannableString raw = newText("W");
      Class<?> map = Class.forName("com.facebook.react.common.mapbuffer.MapBuffer");
      Class<?> writable = Class.forName("com.facebook.react.common.mapbuffer.WritableMapBuffer");
      Constructor<?> ctor = writable.getDeclaredConstructor(); ctor.setAccessible(true);
      Object attrs = ctor.newInstance();
      put(writable, attrs, 3, int.class, 987654); // Real RN cached-spannable fallback, not a fake builder.
      Object paragraph = ctor.newInstance();
      put(writable, paragraph, 2, String.class, "simple");
      put(writable, paragraph, 6, double.class, absolute);
      if (scale != null) put(writable, paragraph, 10, double.class, scale);
      Object state = ctor.newInstance();
      put(writable, state, 0, map, attrs); put(writable, state, 1, map, paragraph);
      java.lang.reflect.Field instance = fitter.getDeclaringClass().getDeclaredField("INSTANCE");
      instance.setAccessible(true);
      Object tlm = instance.get(null);
      Method cache = fitter.getDeclaringClass().getDeclaredMethod(
          "setCachedSpannableForTag", int.class, Spannable.class);
      Method clear = fitter.getDeclaringClass().getDeclaredMethod("deleteCachedSpannableForTag", int.class);
      cache.setAccessible(true); clear.setAccessible(true);
      invoke(cache, tlm, 987654, raw);
      try {
        Method method = ReactTextViewManager.class.getDeclaredMethod("getReactTextUpdate",
            ReactTextView.class, ReactStylesDiffMap.class, map);
        method.setAccessible(true);
        update = invoke(method, manager, view, new ReactStylesDiffMap(JavaOnlyMap.of()), state);
      } finally { invoke(clear, tlm, 987654); }
    }
    apply(manager, view, update);
  }

  private ReactTextView newView() {
    ReactTextView view = new ReactTextView(new ContextThemeWrapper(
        RuntimeEnvironment.getApplication(), androidx.appcompat.R.style.Theme_AppCompat));
    view.setTextSize(TypedValue.COMPLEX_UNIT_PX, 30f);
    view.setAdjustFontSizeToFit(true);
    view.setNumberOfLines(1);
    view.setIncludeFontPadding(false);
    view.setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE);
    view.setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE);
    return view;
  }

  @Test public void measured20_preparedManager_frameRefitCannotCompoundScale_andWideUsesReceivedBaseline()
      throws Exception {
    ReactTextView view = newView();
    ReactTextViewManager manager = new ReactTextViewManager();
    Object measured = measure(Double.NaN, 0.68, 1f);
    Layout measuredLayout = (Layout) value(measured, "layout");
    assertEquals("Real private createLayout has already fitted 30 -> 20", 20, size(measuredLayout.getText()));
    assertEquals(20f, (Float) value(measured, "resolvedMinimumFontSize"), 0f);
    apply(manager, view, preparedUpdate(manager, view, measured));
    assertSame("Manager receives the measured layout's spans", measuredLayout.getText(), view.getSpanned());
    drawAndAssert(view, 1, 20);
    drawAndAssert(view, 2, 20); // A second native frame must not lower the absolute floor.
    drawAndAssert(view, 10000, 20); // Received span baseline is 20, not original premeasurement 30.
    assertEquals("View fits must leave measured/cache-owned spans untouched", 20, size(measuredLayout.getText()));

    // A fresh, wide measurement receives original 30px spans, so it can recover 30.
    Object wide = measure(Double.NaN, 0.68, 10000f);
    assertEquals(30, size(((Layout) value(wide, "layout")).getText()));
    assertEquals(20f, (Float) value(wide, "resolvedMinimumFontSize"), 0f);
    apply(manager, view, preparedUpdate(manager, view, wide));
    drawAndAssert(view, 10000, 30);
    drawAndAssert(view, 1, 20);
    drawAndAssert(view, 10000, 30); // Existing ownership fix restores within the received 30px baseline.
    assertEquals(30, size(((Layout) value(wide, "layout")).getText()));
  }

  @Test public void preparedAndFallback_sameViewTransitions_clearPriorFloorAndScale() throws Exception {
    ReactTextView view = newView();
    ReactTextViewManager manager = new ReactTextViewManager();
    bind(manager, view, false, Double.NaN, 0.68); drawAndAssert(view, 20);
    bind(manager, view, true, Double.NaN, null); drawAndAssert(view, 12);
    bind(manager, view, true, Double.NaN, 0.68); drawAndAssert(view, 20);
    bind(manager, view, false, Double.NaN, Double.NaN); drawAndAssert(view, 12);
    bind(manager, view, false, Double.NaN, 0.68); drawAndAssert(view, 20);
    bind(manager, view, true, Double.NaN, Double.NaN); drawAndAssert(view, 12);
    bind(manager, view, true, Double.NaN, 0.68); drawAndAssert(view, 20);
    bind(manager, view, false, Double.NaN, null); drawAndAssert(view, 12);

    // Legacy six-argument callers supply no metadata: manager must clear both stale values.
    Class<?> cls = Class.forName("com.facebook.react.views.text.PreparedLayout");
    Constructor<?> legacy = cls.getDeclaredConstructor(Layout.class, int.class, float.class,
        int[].class, int.class, int.class);
    legacy.setAccessible(true);
    SpannableString raw = newText("W");
    Layout layout = StaticLayout.Builder.obtain(raw, 0, 1, newPaint(), 10000).setIncludePad(false).build();
    Object input = legacy.newInstance(layout, 1, 0f, new int[0],
        Layout.BREAK_STRATEGY_SIMPLE, Layout.JUSTIFICATION_MODE_NONE);
    assertTrue(Float.isNaN((Float) value(input, "resolvedMinimumFontSize")));
    bind(manager, view, false, 16.9, 0.68); drawAndAssert(view, 16);
    apply(manager, view, preparedRoute(manager, view, input)); drawAndAssert(view, 12);
    Field minimum = ReactTextView.class.getDeclaredField("mMinimumFontSize");
    Field scale = ReactTextView.class.getDeclaredField("mMinimumFontScale");
    minimum.setAccessible(true); scale.setAccessible(true);
    assertTrue(Float.isNaN(minimum.getFloat(view)));
    assertTrue(Float.isNaN(scale.getFloat(view)));
  }

  private Object measure(double absolute, Double scale, float width) throws Exception {
    Class<?> map = Class.forName("com.facebook.react.common.mapbuffer.MapBuffer");
    Class<?> writable = Class.forName("com.facebook.react.common.mapbuffer.WritableMapBuffer");
    Constructor<?> ctor = writable.getDeclaredConstructor(); ctor.setAccessible(true);
    Object paragraph = ctor.newInstance();
    put(writable, paragraph, 0, int.class, 1);
    put(writable, paragraph, 2, String.class, "simple");
    put(writable, paragraph, 3, boolean.class, true);
    put(writable, paragraph, 4, boolean.class, false);
    put(writable, paragraph, 5, String.class, "none");
    put(writable, paragraph, 6, double.class, absolute);
    if (scale != null) put(writable, paragraph, 10, double.class, scale);
    SpannableString text = newText("W");
    assertEquals(30, size(text));
    TextPaint paint = newPaint();
    assertTrue("Actual SDK glyph precondition", Layout.getDesiredWidth(text, paint) > 2f);
    Class<?> tlm = fitter.getDeclaringClass();
    Method create = tlm.getDeclaredMethod("createLayout", Spannable.class, TextPaint.class,
        map, map, float.class, YogaMeasureMode.class, float.class, YogaMeasureMode.class);
    create.setAccessible(true);
    Object receiver = null;
    if (!Modifier.isStatic(create.getModifiers())) {
      Field instance = tlm.getDeclaredField("INSTANCE"); instance.setAccessible(true);
      receiver = instance.get(null);
    }
    return invoke(create, receiver, text, paint, ctor.newInstance(), paragraph,
        width, YogaMeasureMode.EXACTLY, 200f, YogaMeasureMode.EXACTLY);
  }

  private static Object value(Object result, String name) throws Exception {
    Field field = result.getClass().getDeclaredField(name); field.setAccessible(true);
    return field.get(result);
  }

  private Object preparedUpdate(ReactTextViewManager manager, ReactTextView view, Object result)
      throws Exception {
    Class<?> cls = Class.forName("com.facebook.react.views.text.PreparedLayout");
    Constructor<?> constructor = cls.getDeclaredConstructor(Layout.class, int.class, float.class,
        int[].class, int.class, int.class, float.class);
    constructor.setAccessible(true);
    // Mirrors production createPreparedLayout's result transfer; no recalculation from fitted spans.
    Object input = constructor.newInstance(value(result, "layout"), 1, 0f, new int[0],
        value(result, "textBreakStrategy"), value(result, "justificationMode"),
        value(result, "resolvedMinimumFontSize"));
    return preparedRoute(manager, view, input);
  }

  private Object preparedRoute(ReactTextViewManager manager, ReactTextView view, Object input)
      throws Exception {
    Method method = ReactTextViewManager.class.getDeclaredMethod(
        "getReactTextUpdateFromPreparedLayout", ReactTextView.class, input.getClass());
    method.setAccessible(true);
    return invoke(method, manager, view, input);
  }

  private void apply(ReactTextViewManager manager, ReactTextView view, Object update) throws Exception {
    assertNotNull(update);
    manager.updateExtraData(view, update);
    Method after = ReactTextViewManager.class.getDeclaredMethod("onAfterUpdateTransaction", ReactTextView.class);
    after.setAccessible(true);
    invoke(after, manager, view);
  }

  private static int size(CharSequence text) {
    Spanned spanned = (Spanned) text;
    AbsoluteSizeSpan[] spans = spanned.getSpans(0, text.length(), AbsoluteSizeSpan.class);
    assertEquals(1, spans.length);
    return spans[0].getSize();
  }

  private void drawAndAssert(ReactTextView view, int expected) {
    drawAndAssert(view, 1, expected);
  }

  private void drawAndAssert(ReactTextView view, int width, int expected) {
    view.measure(android.view.View.MeasureSpec.makeMeasureSpec(width, android.view.View.MeasureSpec.EXACTLY),
        android.view.View.MeasureSpec.makeMeasureSpec(200, android.view.View.MeasureSpec.EXACTLY));
    view.layout(0, 0, width, 200);
    assertEquals(width, view.getWidth());
    Bitmap bitmap = Bitmap.createBitmap(width, 200, Bitmap.Config.ARGB_8888);
    try { view.draw(new Canvas(bitmap)); } finally { bitmap.recycle(); }
    Spanned displayed = (Spanned) view.getText();
    AbsoluteSizeSpan[] spans = displayed.getSpans(0, 1, AbsoluteSizeSpan.class);
    assertEquals(1, spans.length);
    assertEquals("Actual manager->view->draw floor", expected, spans[0].getSize());
    if (width <= 2) assertEquals(expected, view.getPaint().getTextSize(), 0.001f);
  }
}
