package app.captionstudio.media;

import static org.junit.Assert.*;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Typeface;
import android.text.Annotation;
import android.text.Layout;
import android.text.Selection;
import android.text.Spannable;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.style.AbsoluteSizeSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.ContextThemeWrapper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import com.facebook.react.uimanager.DisplayMetricsHolder;
import com.facebook.react.views.text.ReactTextView;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

/**
 * Candidate: actual RN view, PreparedLayout, RN spans and draw path; no copied fitter or RN shadows.
 * Run on the parent's source-built RN with the separately validated arithmetic repair.
 * A compile/link/constructor/JNI failure is a harness ERROR, never the ownership RED.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class ReactTextViewOwnershipTest {
  private static final int RAW_PX = 30;
  private static final int FLOOR_PX = 12; // NaN minimum => 4dp at RN density 3.
  private static final int HEIGHT = 100;
  private static final int WIDE = 2000;
  private static final int REACT_TAG = 7301;
  private static final int FLAGS =
      Spanned.SPAN_EXCLUSIVE_EXCLUSIVE | (3 << Spanned.SPAN_PRIORITY_SHIFT);
  // One wide glyph guarantees the fitter's single-character width check at width 1.
  private static final String TEXT = "W";

  private DisplayMetrics oldWindow;
  private DisplayMetrics oldScreen;
  private boolean metricsInstalled;
  private Class<? extends AbsoluteSizeSpan> rnSizeClass;
  private Constructor<? extends AbsoluteSizeSpan> rnSizeConstructor;

  @Before public void setUp() throws Exception {
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
    rnSizeClass = Class.forName(
        "com.facebook.react.views.text.internal.span.ReactAbsoluteSizeSpan")
        .asSubclass(AbsoluteSizeSpan.class);
    rnSizeConstructor = rnSizeClass.getDeclaredConstructor(int.class);
    rnSizeConstructor.setAccessible(true);
    System.out.println("RN_VIEW_ORIGIN " + ReactTextView.class.getResource("ReactTextView.class"));
    System.out.println("RN_FITTER_ORIGIN " + Class.forName(
        "com.facebook.react.views.text.TextLayoutManager").getResource("TextLayoutManager.class"));
  }

  @After public void tearDown() {
    if (metricsInstalled) {
      DisplayMetricsHolder.setWindowDisplayMetrics(oldWindow);
      DisplayMetricsHolder.setScreenDisplayMetrics(oldScreen);
    }
  }

  @Test public void narrowDraw_ownsFittedTextAndPaint_withoutMutatingCachedInput() throws Exception {
    CachedInput cached = new CachedInput();
    ReactTextView view = newView(cached, true);
    TextPaint base = copyPaint(view.getPaint());
    frameAndDraw(view, 1);

    // Establish the real draw/fitter ran before checking the expected ownership RED.
    assertSize(view.getText(), FLOOR_PX);
    assertMetadata((Spanned) view.getText(), cached);
    assertNotSame("Fitted presentation must have its own span container", cached.text, view.getText());
    assertSize(cached.layout.getText(), RAW_PX);
    assertSame(cached.rawSize, sizeSpan(cached.text));
    assertSame(cached.text, view.getSpanned());
    // The view paint is presentation state: it must consume the fitter's base-size output.
    assertEquals(FLOOR_PX, view.getPaint().getTextSize(), 0f);
    assertEquals(base.density, view.getPaint().density, 0f);
    assertBasePaint(cached.layoutPaintBefore, cached.layout.getPaint());
    assertMetadata(cached.text, cached);
  }

  @Test public void sameView_frameChanges_refitFromRaw30_withoutNewText() throws Exception {
    CachedInput cached = new CachedInput();
    ReactTextView view = newView(cached, true);
    // Exercise selection across both initial fitting and later frame-driven refitting.
    view.setTextIsSelectable(true);
    Selection.setSelection((Spannable) view.getText(), 0, TEXT.length());
    TextPaint base = copyPaint(view.getPaint());
    frameAndDraw(view, 1);
    assertSize(view.getText(), FLOOR_PX);
    assertSelection(view);

    // No setText, setSpanned or fitting-property setter after the first draw.
    frameAndDraw(view, WIDE);
    assertSize(view.getText(), RAW_PX);
    assertSelection(view);
    assertMetadata((Spanned) view.getText(), cached);
    assertEquals(REACT_TAG, view.reactTagForTouch(
        view.getLayout().getLineLeft(0) + 1, view.getLayout().getLineTop(0) + 1));
    frameAndDraw(view, 1);
    assertSize(view.getText(), FLOOR_PX);
    frameAndDraw(view, WIDE);
    assertSize(view.getText(), RAW_PX);
    assertSize(cached.text, RAW_PX);
    assertBasePaint(base, view.getPaint());
  }

  @Test public void sharedPreparedText_narrowViewCannotPoisonWideViews_boundBeforeOrAfter()
      throws Exception {
    CachedInput cached = new CachedInput();
    ReactTextView narrow = newView(cached, true);
    ReactTextView boundBefore = newView(cached, true);
    assertSame(narrow.getPreparedLayout(), boundBefore.getPreparedLayout());
    frameAndDraw(narrow, 1);
    assertSize(narrow.getText(), FLOOR_PX);

    frameAndDraw(boundBefore, WIDE);
    assertSize(boundBefore.getText(), RAW_PX);
    ReactTextView boundAfter = newView(cached, true);
    frameAndDraw(boundAfter, WIDE);
    assertSize(boundAfter.getText(), RAW_PX);
    assertSize(cached.text, RAW_PX);
    assertMetadata((Spanned) boundBefore.getText(), cached);
    assertMetadata((Spanned) boundAfter.getText(), cached);
  }

  @Test public void fittingDisabled_frameChangesPreserveRawTextStylesTagsAndSelection()
      throws Exception {
    CachedInput cached = new CachedInput();
    ReactTextView view = newView(cached, false);
    view.setTextIsSelectable(true);
    Selection.setSelection((Spannable) view.getText(), 0, TEXT.length());
    TextPaint base = copyPaint(view.getPaint());
    frameAndDraw(view, 1);
    assertSize(view.getText(), RAW_PX);
    assertSelection(view);
    frameAndDraw(view, WIDE);
    assertSize(view.getText(), RAW_PX);
    assertSelection(view);
    assertMetadata((Spanned) view.getText(), cached);
    assertMetadata(cached.text, cached);
    assertBasePaint(base, view.getPaint());
  }

  @Test public void noRnSizeSpan_drawConsumesFittedBasePaintMinimum() throws Exception {
    CachedInput cached = new CachedInput(false, 6f);
    ReactTextView view = newView(cached, true, 6f);
    assertEquals(0, cached.text.getSpans(0, TEXT.length(), rnSizeClass).length);
    frameAndDraw(view, WIDE);
    // Parent fitter applies max(originalPaintSize * 1, minimum), even without RN spans.
    // TextView consumes this output for runs whose size comes from its base paint.
    assertEquals(FLOOR_PX, view.getPaint().getTextSize(), 0f);
    assertEquals(0, ((Spanned) view.getText()).getSpans(
        0, TEXT.length(), rnSizeClass).length);
    assertEquals(0, cached.text.getSpans(0, TEXT.length(), rnSizeClass).length);
    assertSame(cached.text, view.getSpanned());
    assertBasePaint(cached.layoutPaintBefore, cached.layout.getPaint());
  }

  @Test public void rawBaseSetterAfterFit_rearmsSameFrame_andWideUsesNewBase() throws Exception {
    CachedInput cached = new CachedInput();
    ReactTextView view = newView(cached, true);
    frameAndDraw(view, 1);
    assertEquals(FLOOR_PX, view.getTextSize(), 0f);
    view.setTextSize(TypedValue.COMPLEX_UNIT_PX, 60f);
    frameAndDraw(view, 1); // Same dimensions: setter must re-arm fitting.
    assertSize(view.getText(), FLOOR_PX);
    assertEquals(24f, view.getTextSize(), 0f); // 60 * (12 / 30).
    frameAndDraw(view, WIDE);
    assertEquals(60f, view.getTextSize(), 0f);
    assertSize(view.getText(), RAW_PX);
    assertMetadata((Spanned) view.getText(), cached);
    assertBasePaint(cached.layoutPaintBefore, cached.layout.getPaint());
  }

  @Test public void rawBaseSetterEqualToFittedSize_isStillAuthoritative() throws Exception {
    CachedInput cached = new CachedInput();
    ReactTextView view = newView(cached, true);
    frameAndDraw(view, 1);
    assertEquals(FLOOR_PX, view.getTextSize(), 0f);
    view.setTextSize(TypedValue.COMPLEX_UNIT_PX, FLOOR_PX);
    frameAndDraw(view, WIDE);
    assertEquals(FLOOR_PX, view.getTextSize(), 0f);
    assertSize(view.getText(), RAW_PX); // Raw spans and base paint are independent.
    assertSize(cached.text, RAW_PX);
  }

  @Test public void oneArgumentTextSizeSetterAfterFit_usesAppliedSpPixels() throws Exception {
    CachedInput cached = new CachedInput();
    ReactTextView view = newView(cached, true);
    frameAndDraw(view, 1);
    // Android uses the view resources for this setter, not RN's DisplayMetricsHolder.
    float expected = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 60f,
        view.getResources().getDisplayMetrics());
    view.setTextSize(60f);
    assertEquals(expected, view.getTextSize(), 0f);
    frameAndDraw(view, WIDE);
    assertEquals(expected, view.getTextSize(), 0f);
    assertSize(view.getText(), RAW_PX);
  }

  @Test public void fontSizePropertyAfterFit_rearmsAndReplacesRawBase() throws Exception {
    CachedInput cached = new CachedInput();
    ReactTextView view = newView(cached, true);
    frameAndDraw(view, 1);
    float expected = (float) Math.ceil(
        com.facebook.react.uimanager.PixelUtil.toPixelFromSP(20f));
    view.setFontSize(20f);
    assertEquals(expected, view.getTextSize(), 0f);
    frameAndDraw(view, 1);
    assertSize(view.getText(), FLOOR_PX);
    assertEquals(Math.max(expected * (FLOOR_PX / (float) RAW_PX), FLOOR_PX),
        view.getTextSize(), 0.001f);
    frameAndDraw(view, WIDE);
    assertSize(view.getText(), RAW_PX);
    assertEquals(expected, view.getTextSize(), 0f);
    assertBasePaint(cached.layoutPaintBefore, cached.layout.getPaint());
  }

  @Test public void propertyApplyAfterFit_restoresFontPropertyAndRearmsSameFrame()
      throws Exception {
    CachedInput cached = new CachedInput();
    ReactTextView view = newView(cached, true);
    float propertyPx = (float) Math.ceil(
        com.facebook.react.uimanager.PixelUtil.toPixelFromSP(10f));
    view.setFontSize(10f);
    frameAndDraw(view, 1);
    view.setTextSize(TypedValue.COMPLEX_UNIT_PX, 60f);
    frameAndDraw(view, 1);
    assertEquals(24f, view.getTextSize(), 0f);
    // Existing setLetterSpacing invokes the real private applyTextAttributes path.
    view.setLetterSpacing(0f);
    assertEquals(propertyPx, view.getTextSize(), 0f);
    frameAndDraw(view, 1);
    assertEquals(Math.max(propertyPx * (FLOOR_PX / (float) RAW_PX), FLOOR_PX),
        view.getTextSize(), 0.001f);
    frameAndDraw(view, WIDE);
    assertEquals(propertyPx, view.getTextSize(), 0f);
    assertSize(view.getText(), RAW_PX);
    assertMetadata((Spanned) view.getText(), cached);
  }

  @Test public void noRnSizeSpan_largeBaseDoesNotInventShrink() throws Exception {
    CachedInput cached = new CachedInput(false, RAW_PX);
    ReactTextView view = newView(cached, true);
    frameAndDraw(view, 1);
    assertEquals(RAW_PX, view.getTextSize(), 0f); // No RN spans => search ratio 1.
    frameAndDraw(view, WIDE);
    assertEquals(RAW_PX, view.getTextSize(), 0f);
    assertEquals(0, ((Spanned) view.getText()).getSpans(
        0, TEXT.length(), rnSizeClass).length);
    assertBasePaint(cached.layoutPaintBefore, cached.layout.getPaint());
  }

  @Test public void noRnSizeSpan_minimumUpdatesAlwaysStartAtRawBase() throws Exception {
    CachedInput cached = new CachedInput(false, 6f);
    ReactTextView view = newView(cached, true, 6f);
    frameAndDraw(view, WIDE);
    assertEquals(FLOOR_PX, view.getTextSize(), 0f);
    view.setMinimumFontSize(0f);
    frameAndDraw(view, WIDE);
    assertEquals(6f, view.getTextSize(), 0f); // Must not seed from the previous 12.
    view.setMinimumFontSize(18f);
    frameAndDraw(view, WIDE);
    assertEquals(18f, view.getTextSize(), 0f);
    view.setMinimumFontSize(Float.NaN);
    frameAndDraw(view, WIDE);
    assertEquals(FLOOR_PX, view.getTextSize(), 0f);
    view.setMinimumFontSize(0f);
    frameAndDraw(view, WIDE);
    assertEquals(6f, view.getTextSize(), 0f);
    assertEquals(0, ((Spanned) view.getText()).getSpans(
        0, TEXT.length(), rnSizeClass).length);
    assertBasePaint(cached.layoutPaintBefore, cached.layout.getPaint());
  }

  @Test public void explicitMinimumForSpans_preservesRawInputAndRecoversWide() throws Exception {
    CachedInput cached = new CachedInput();
    ReactTextView view = newView(cached, true);
    view.setMinimumFontSize(18f);
    frameAndDraw(view, 1);
    assertSize(view.getText(), 18);
    assertEquals(18f, view.getTextSize(), 0f);
    view.setMinimumFontSize(Float.NaN);
    frameAndDraw(view, 1);
    assertSize(view.getText(), FLOOR_PX);
    frameAndDraw(view, WIDE);
    assertSize(view.getText(), RAW_PX);
    assertEquals(RAW_PX, view.getTextSize(), 0f);
    assertSize(cached.text, RAW_PX);
    assertMetadata((Spanned) view.getText(), cached);
    assertBasePaint(cached.layoutPaintBefore, cached.layout.getPaint());
  }

  @Test public void recycleAfterFit_restoresRawSetterBase_andReusesActualView() throws Exception {
    CachedInput old = new CachedInput();
    ReactTextView view = newView(old, true);
    view.setFontSize(10f);
    frameAndDraw(view, 1);
    view.setTextSize(TypedValue.COMPLEX_UNIT_PX, 45f);
    frameAndDraw(view, 1);
    assertEquals(18f, view.getTextSize(), 0f);
    Method recycle = ReactTextView.class.getDeclaredMethod("recycleView");
    recycle.setAccessible(true);
    recycle.invoke(view); // Actual recycle path, including initView/applyTextAttributes.
    assertEquals(45f, view.getTextSize(), 0f);
    assertNull(view.getSpanned());
    assertNull(view.getPreparedLayout());
    assertEquals("", view.getText().toString());
    view.setLetterSpacing(0f); // Stale font property must have been cleared by initView.
    assertEquals(45f, view.getTextSize(), 0f);

    CachedInput next = new CachedInput(false, 45f);
    bindReusedView(view, next);
    frameAndDraw(view, WIDE); // Recycle disabled fitting: raw base remains 45.
    assertEquals(45f, view.getTextSize(), 0f);
    view.setAdjustFontSizeToFit(true);
    view.setMinimumFontSize(Float.NaN);
    frameAndDraw(view, WIDE);
    assertEquals(45f, view.getTextSize(), 0f);
    view.setFontSize(20f);
    float expected = (float) Math.ceil(
        com.facebook.react.uimanager.PixelUtil.toPixelFromSP(20f));
    frameAndDraw(view, WIDE);
    assertEquals(expected, view.getTextSize(), 0f);
    assertSame(next.text, view.getSpanned());
    assertBasePaint(next.layoutPaintBefore, next.layout.getPaint());
    assertBasePaint(old.layoutPaintBefore, old.layout.getPaint());
    assertSize(old.text, RAW_PX);
  }

  @Test public void sameView_heightOnlyChange_rearmsFitFromRaw() throws Exception {
    CachedInput cached = new CachedInput();
    ReactTextView view = newView(cached, true);
    frameAndDrawAtHeight(view, 1);
    assertSize(view.getText(), FLOOR_PX);
    frameAndDrawAtHeight(view, HEIGHT);
    assertSize(view.getText(), RAW_PX);
    assertEquals(RAW_PX, view.getTextSize(), 0f);
    assertBasePaint(cached.layoutPaintBefore, cached.layout.getPaint());
  }

  @Test public void fittingDisabled_settersAndRecyclePreserveAppliedBaseAndUnits()
      throws Exception {
    CachedInput cached = new CachedInput();
    ReactTextView view = newView(cached, false);
    view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f);
    float applied = view.getTextSize();
    frameAndDraw(view, 1);
    assertEquals(applied, view.getTextSize(), 0f);
    assertSize(view.getText(), RAW_PX);
    assertMetadata((Spanned) view.getText(), cached);
    Method recycle = ReactTextView.class.getDeclaredMethod("recycleView");
    recycle.setAccessible(true);
    recycle.invoke(view);
    assertEquals(applied, view.getTextSize(), 0f);
    assertEquals(TypedValue.COMPLEX_UNIT_SP, view.getTextSizeUnit());
    assertBasePaint(cached.layoutPaintBefore, cached.layout.getPaint());
  }

  private void bindReusedView(ReactTextView view, CachedInput cached) throws Exception {
    view.setSpanned(cached.text);
    Method setter = ReactTextView.class.getDeclaredMethod(
        "setPreparedLayout", cached.prepared.getClass());
    setter.setAccessible(true);
    setter.invoke(view, cached.prepared);
    Class<?> updateClass = Class.forName("com.facebook.react.views.text.ReactTextUpdate");
    Constructor<?> constructor = updateClass.getDeclaredConstructor(
        Spanned.class, int.class, int.class, int.class, int.class);
    constructor.setAccessible(true);
    Object update = constructor.newInstance(cached.text, -1, Gravity.START,
        Layout.BREAK_STRATEGY_SIMPLE, Layout.JUSTIFICATION_MODE_NONE);
    ReactTextView.class.getMethod("setText", updateClass).invoke(view, update);
    view.updateView();
    assertSame(cached.prepared, view.getPreparedLayout());
  }

  private static void frameAndDrawAtHeight(ReactTextView view, int height) {
    view.measure(View.MeasureSpec.makeMeasureSpec(WIDE, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
    view.layout(0, 0, WIDE, height);
    assertEquals(WIDE, view.getWidth());
    assertEquals(height, view.getHeight());
    Bitmap bitmap = Bitmap.createBitmap(64, HEIGHT, Bitmap.Config.ARGB_8888);
    try { view.draw(new Canvas(bitmap)); }
    finally { bitmap.recycle(); }
    assertNotNull("Actual TextView layout must exist after draw", view.getLayout());
  }

  private ReactTextView newView(CachedInput cached, boolean fit) throws Exception {
    return newView(cached, fit, RAW_PX);
  }

  private ReactTextView newView(CachedInput cached, boolean fit, float basePx) throws Exception {
    // No constructor bypass, subclass, mocked ReactContext, new shadow or feature-flag override.
    ReactTextView view = new ReactTextView(new ContextThemeWrapper(
        RuntimeEnvironment.getApplication(), androidx.appcompat.R.style.Theme_AppCompat));
    view.setId(7201);
    view.setLayoutParams(new ViewGroup.LayoutParams(WIDE, HEIGHT));
    view.setPadding(0, 0, 0, 0);
    view.setTextSize(TypedValue.COMPLEX_UNIT_PX, basePx);
    view.getPaint().density = 3f;
    view.setIncludeFontPadding(false);
    view.setNumberOfLines(1);
    view.setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE);
    view.setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE);
    view.setAdjustFontSizeToFit(fit);
    view.setMinimumFontSize(Float.NaN);
    view.setSpanned(cached.text);

    // Set the real PreparedLayout and real ReactTextUpdate through their existing RN APIs.
    // Reflection only bridges Kotlin internal/package visibility, never constructs fake RN state.
    Method preparedSetter = ReactTextView.class.getDeclaredMethod(
        "setPreparedLayout", cached.prepared.getClass());
    preparedSetter.setAccessible(true);
    preparedSetter.invoke(view, cached.prepared);
    Class<?> updateClass = Class.forName("com.facebook.react.views.text.ReactTextUpdate");
    Constructor<?> updateConstructor = updateClass.getDeclaredConstructor(
        Spanned.class, int.class, int.class, int.class, int.class);
    updateConstructor.setAccessible(true);
    Object update = updateConstructor.newInstance(cached.text, -1, Gravity.START,
        Layout.BREAK_STRATEGY_SIMPLE, Layout.JUSTIFICATION_MODE_NONE);
    ReactTextView.class.getMethod("setText", updateClass).invoke(view, update);
    view.updateView();
    assertSame(cached.prepared, view.getPreparedLayout());
    if (cached.rawSize != null) assertSize(view.getText(), RAW_PX);
    else assertEquals(0, ((Spanned) view.getText()).getSpans(
        0, TEXT.length(), rnSizeClass).length);
    return view;
  }

  private static void frameAndDraw(ReactTextView view, int width) {
    view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(HEIGHT, View.MeasureSpec.EXACTLY));
    view.layout(0, 0, width, HEIGHT);
    assertEquals(width, view.getWidth());
    assertEquals(HEIGHT, view.getHeight());
    // Geometry is 2000x100 for the wide frame; backing bitmap stays bounded at 64x100.
    Bitmap bitmap = Bitmap.createBitmap(64, HEIGHT, Bitmap.Config.ARGB_8888);
    try { view.draw(new Canvas(bitmap)); }
    finally { bitmap.recycle(); }
    assertNotNull("Actual TextView layout must exist after draw", view.getLayout());
  }

  private final class CachedInput {
    final SpannableString text = new SpannableString(TEXT);
    final AbsoluteSizeSpan rawSize;
    final Object reactTag;
    final Object fragmentIndex;
    final StyleSpan style = new StyleSpan(Typeface.BOLD);
    final ForegroundColorSpan color = new ForegroundColorSpan(Color.BLUE);
    final Annotation accessibility = new Annotation("accessibility", "root-toolbar");
    final StaticLayout layout;
    final TextPaint layoutPaintBefore;
    final Object prepared;

    CachedInput() throws Exception { this(true, RAW_PX); }

    CachedInput(boolean includeRnSize, float basePx) throws Exception {
      rawSize = includeRnSize ? rnSizeConstructor.newInstance(RAW_PX) : null;
      reactTag = internalSpan("ReactTagSpan", REACT_TAG);
      fragmentIndex = internalSpan("ReactFragmentIndexSpan", 0);
      for (Object span : new Object[] {
          rawSize, reactTag, fragmentIndex, style, color, accessibility}) {
        if (span != null) text.setSpan(span, 0, TEXT.length(), FLAGS);
      }
      TextPaint paint = new TextPaint(TextPaint.ANTI_ALIAS_FLAG);
      paint.setTextSize(basePx);
      paint.density = 3f;
      layout = StaticLayout.Builder.obtain(text, 0, text.length(), paint, WIDE)
          .setIncludePad(false).setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE).build();
      assertSame("Fixture must actually retain caller spannable", text, layout.getText());
      layoutPaintBefore = copyPaint(layout.getPaint());
      Class<?> preparedClass = Class.forName("com.facebook.react.views.text.PreparedLayout");
      Constructor<?> constructor = preparedClass.getDeclaredConstructor(
          Layout.class, int.class, float.class, int[].class, int.class, int.class);
      constructor.setAccessible(true);
      prepared = constructor.newInstance(layout, 1, 0f, new int[] {REACT_TAG},
          Layout.BREAK_STRATEGY_SIMPLE, Layout.JUSTIFICATION_MODE_NONE);
    }
  }

  private static Object internalSpan(String name, int value) throws Exception {
    Constructor<?> constructor = Class.forName(
        "com.facebook.react.views.text.internal.span." + name).getDeclaredConstructor(int.class);
    constructor.setAccessible(true);
    return constructor.newInstance(value);
  }

  private AbsoluteSizeSpan sizeSpan(CharSequence value) {
    assertTrue(value instanceof Spanned);
    AbsoluteSizeSpan[] sizes = ((Spanned) value).getSpans(0, value.length(), rnSizeClass);
    assertEquals("Exactly one actual RN absolute-size span", 1, sizes.length);
    return sizes[0];
  }

  private void assertSize(CharSequence value, int expected) {
    assertEquals(expected, sizeSpan(value).getSize());
  }

  private void assertMetadata(Spanned text, CachedInput cached) {
    assertEquals(TEXT, text.toString());
    for (Object span : new Object[] {sizeSpan(text), cached.reactTag,
        cached.fragmentIndex, cached.style, cached.color, cached.accessibility}) {
      assertEquals(0, text.getSpanStart(span));
      assertEquals(TEXT.length(), text.getSpanEnd(span));
      assertEquals(FLAGS, text.getSpanFlags(span));
    }
  }

  private static TextPaint copyPaint(TextPaint source) {
    TextPaint copy = new TextPaint();
    copy.set(source); // TextPaint(Paint) alone loses TextPaint-specific fields such as density.
    return copy;
  }

  private static void assertBasePaint(TextPaint expected, TextPaint actual) {
    assertEquals(expected.getTextSize(), actual.getTextSize(), 0f);
    assertEquals(expected.density, actual.density, 0f);
    assertEquals(expected.baselineShift, actual.baselineShift);
    assertEquals(expected.linkColor, actual.linkColor);
  }

  private static void assertSelection(ReactTextView view) {
    assertEquals(0, view.getSelectionStart());
    assertEquals(TEXT.length(), view.getSelectionEnd());
  }
}
