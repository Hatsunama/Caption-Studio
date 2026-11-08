package app.captionstudio.media;

import static org.junit.Assert.*;

import android.text.Layout;
import android.text.StaticLayout;
import com.facebook.react.fabric.FabricUIManager;
import com.facebook.react.views.text.ReactTextView;
import com.facebook.react.views.text.ReactTextViewManager;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;

/** Real Fabric retag body and SDK36 native graphics. No replacement retag implementation.
 * Only the unrelated fabricjni library loader is isolated, in this suite's sandbox alone.
 * Constructor-free receiver is valid ONLY for the audited stateless retag method.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36, manifest = Config.NONE,
    shadows = ReactNativeMinimumScaleCachedRetagTest.NoFabricJniLoader.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class ReactNativeMinimumScaleCachedRetagTest extends ReactNativeMinimumScaleTestSupport {
  @Implements(className = "com.facebook.react.fabric.FabricSoLoader", isInAndroidSdk = false)
  public static class NoFabricJniLoader {
    @Implementation protected static void staticInit() {
      // No Fabric lifecycle or JNI path is exercised. Android text/graphics stay native.
    }
  }

  private ReactNativeMinimumScaleManagerRoutesTest routes;
  private Object fabric;

  @Before public void isolateStatelessFabricReceiver() throws Exception {
    routes = new ReactNativeMinimumScaleManagerRoutesTest();
    // This helper is not JUnit-owned: initialize and release its entire fixture.
    routes.setUp();
    assertNotNull(routes.newText("fixture setup must initialize the real span constructor"));
    routes.useOfficialJvmFeatureFlagFixture();
    Class<?> unsafeClass = Class.forName("sun.misc.Unsafe");
    Field singleton = unsafeClass.getDeclaredField("theUnsafe");
    singleton.setAccessible(true);
    fabric = unsafeClass.getMethod("allocateInstance", Class.class)
        .invoke(singleton.get(null), FabricUIManager.class);
    assertEquals(FabricUIManager.class, fabric.getClass());
    for (String name : new String[] {"mReactApplicationContext", "mMountingManager", "mBinding"}) {
      Field field = FabricUIManager.class.getDeclaredField(name);
      field.setAccessible(true);
      assertNull("No Fabric context/lifecycle constructed: " + name, field.get(fabric));
    }
    System.out.println("RN_RETAG resource=" + FabricUIManager.class.getResource("FabricUIManager.class")
        + " loader=" + FabricUIManager.class.getClassLoader());
  }

  @After public void restoreOfficialFlags() throws Exception {
    try {
      if (routes != null) routes.restorePreviousFeatureFlagObjects();
    } finally {
      if (routes != null) routes.tearDown();
      fabric = null;
    }
  }

  // Reuse the existing real measurement/manager/draw fixture without changing its suite or lifecycle.
  private Object routeHelper(String name, Class<?>[] types, Object... args) throws Exception {
    Method method = ReactNativeMinimumScaleManagerRoutesTest.class.getDeclaredMethod(name, types);
    method.setAccessible(true);
    return invoke(method, routes, args);
  }

  private static Object property(Object prepared, String name) throws Exception {
    return invoke(prepared.getClass().getMethod("get" + name), prepared);
  }

  private Object retag(Object prepared, int[] tags) throws Exception {
    Method method = FabricUIManager.class.getDeclaredMethod(
        "reusePreparedLayoutWithNewReactTags", prepared.getClass(), int[].class);
    assertEquals(FabricUIManager.class, method.getDeclaringClass());
    return invoke(method, fabric, prepared, tags);
  }

  private Object prepared(boolean legacy) throws Exception {
    Class<?> cls = Class.forName("com.facebook.react.views.text.PreparedLayout");
    if (legacy) {
      Constructor<?> ctor = cls.getDeclaredConstructor(Layout.class, int.class, float.class,
          int[].class, int.class, int.class);
      ctor.setAccessible(true);
      android.text.SpannableString raw = newText("W");
      Layout layout = StaticLayout.Builder.obtain(raw, 0, 1, newPaint(), 10000)
          .setIncludePad(false).build();
      return ctor.newInstance(layout, 1, 3.5f, new int[] {101},
          Layout.BREAK_STRATEGY_SIMPLE, Layout.JUSTIFICATION_MODE_NONE);
    }
    Object measured = routeHelper("measure", new Class<?>[] {double.class, Double.class, float.class},
        Double.NaN, Double.valueOf(0.68), 1f);
    Field layout = measured.getClass().getDeclaredField("layout"); layout.setAccessible(true);
    Field floor = measured.getClass().getDeclaredField("resolvedMinimumFontSize"); floor.setAccessible(true);
    assertEquals(20f, floor.getFloat(measured), 0f);
    Constructor<?> ctor = cls.getDeclaredConstructor(Layout.class, int.class, float.class,
        int[].class, int.class, int.class, float.class);
    ctor.setAccessible(true);
    return ctor.newInstance(layout.get(measured), 1, 3.5f, new int[] {101},
        Layout.BREAK_STRATEGY_SIMPLE, Layout.JUSTIFICATION_MODE_NONE, floor.getFloat(measured));
  }

  private void assertRetagOnly(Object original, Object reused, int[] tags) throws Exception {
    assertNotSame(original, reused);
    assertSame(property(original, "Layout"), property(reused, "Layout"));
    assertSame(tags, property(reused, "ReactTags"));
    assertArrayEquals(new int[] {101}, (int[]) property(original, "ReactTags"));
    for (String name : new String[] {"MaximumNumberOfLines", "VerticalOffset",
        "TextBreakStrategy", "JustificationMode"}) {
      assertEquals("Retag preserves " + name, property(original, name), property(reused, name));
    }
  }

  private ReactTextView view() throws Exception {
    return (ReactTextView) routeHelper("newView", new Class<?>[0]);
  }

  private void apply(ReactTextViewManager manager, ReactTextView view, Object prepared) throws Exception {
    Object update = routeHelper("preparedRoute",
        new Class<?>[] {ReactTextViewManager.class, ReactTextView.class, Object.class}, manager, view, prepared);
    routeHelper("apply", new Class<?>[] {ReactTextViewManager.class, ReactTextView.class, Object.class},
        manager, view, update);
  }

  private void draw(ReactTextView view, int width, int floor, int basePaint) throws Exception {
    routeHelper("drawAndAssert", new Class<?>[] {ReactTextView.class, int.class, int.class, int.class},
        view, width, floor, basePaint);
  }

  @Test public void cachedRetag_retains20_andRepeatedRetagDoesNotCompoundFloor() throws Exception {
    Object original = prepared(false);
    int[] tags = {202};
    Object reused = retag(original, tags);
    assertRetagOnly(original, reused, tags);
    assertEquals("Cached retag must retain resolved 20px floor", 20f,
        (Float) property(reused, "ResolvedMinimumFontSize"), 0f);
    Object twice = retag(reused, new int[] {303});
    assertEquals(20f, (Float) property(twice, "ResolvedMinimumFontSize"), 0f);
    assertSame(property(original, "Layout"), property(twice, "Layout"));
    assertArrayEquals(new int[] {202}, (int[]) property(reused, "ReactTags"));
    assertEquals(20f, (Float) property(original, "ResolvedMinimumFontSize"), 0f);
  }

  @Test public void cachedRetag_managerNativeDrawKeeps20_andOwnsItsFitCopies() throws Exception {
    Object original = prepared(false);
    Object reused = retag(original, new int[] {202});
    ReactTextView first = view(); ReactTextView second = view();
    ReactTextViewManager manager = new ReactTextViewManager();
    apply(manager, first, reused); apply(manager, second, original);
    Layout cached = (Layout) property(original, "Layout");
    assertSame(cached, property(reused, "Layout"));
    assertSame(cached.getText(), first.getSpanned());
    draw(first, 1, 20, 30); draw(first, 2, 20, 30); draw(first, 10000, 20, 30);
    draw(second, 1, 20, 30);
    assertNotSame("Displayed fit belongs to view", cached.getText(), first.getText());
    assertNotSame("Views own separate displayed fits", first.getText(), second.getText());
    android.text.Spanned text = (android.text.Spanned) cached.getText();
    android.text.style.AbsoluteSizeSpan[] spans = text.getSpans(0, text.length(),
        android.text.style.AbsoluteSizeSpan.class);
    assertEquals(1, spans.length); assertEquals(20, spans[0].getSize());
    assertArrayEquals(new int[] {101}, (int[]) property(original, "ReactTags"));
  }

  @Test public void legacySixArgumentNaN_survivesRetag_andClearsStaleViewFloor() throws Exception {
    Object original = prepared(true);
    assertTrue(Float.isNaN((Float) property(original, "ResolvedMinimumFontSize")));
    int[] tags = {202}; Object reused = retag(original, tags);
    assertRetagOnly(original, reused, tags);
    assertTrue(Float.isNaN((Float) property(reused, "ResolvedMinimumFontSize")));
    ReactTextView view = view(); ReactTextViewManager manager = new ReactTextViewManager();
    routeHelper("bind", new Class<?>[] {ReactTextViewManager.class, ReactTextView.class,
        boolean.class, double.class, Double.class}, manager, view, false, 16.9, Double.valueOf(0.68));
    draw(view, 1, 16, 16);
    apply(manager, view, reused); draw(view, 1, 12, 12);
    for (String name : new String[] {"mMinimumFontSize", "mMinimumFontScale"}) {
      Field field = ReactTextView.class.getDeclaredField(name); field.setAccessible(true);
      assertTrue("Legacy retag clears " + name, Float.isNaN(field.getFloat(view)));
    }
    assertTrue(Float.isNaN((Float) property(original, "ResolvedMinimumFontSize")));
  }
}
