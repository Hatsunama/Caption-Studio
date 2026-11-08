package app.captionstudio.media;
import static org.junit.Assert.*;
import android.text.Layout;
import android.text.Spannable;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.TextPaint;
import android.text.style.AbsoluteSizeSpan;
import com.facebook.yoga.YogaMeasureMode;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36, manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class ReactNativeMinimumScaleOverloadTest extends ReactNativeMinimumScaleTestSupport {
  @Test public void scaleUsesLargestOriginalSpan_andKeepsFractionalPaintWhenAlreadyFits() throws Exception {
    SpannableString tight = mixed();
    apply(tight, newPaint(), 1f, Float.NaN, .68f);
    for (AbsoluteSizeSpan span : tight.getSpans(0, 2, AbsoluteSizeSpan.class))
      assertEquals(40, span.getSize()); // literal floor: largest input is 60px, not paint or first span.
    SpannableString ample = mixed();
    TextPaint paint = newPaint(); paint.setTextSize(51.25f);
    apply(ample, paint, 10000f, Float.NaN, .68f);
    AbsoluteSizeSpan[] spans = ample.getSpans(0, 2, AbsoluteSizeSpan.class);
    assertEquals(40, spans[0].getSize()); assertEquals(60, spans[1].getSize());
    assertEquals(51.25f, paint.getTextSize(), 0.001f);
    // Upstream clamps each smaller span to the global floor even when the largest fits.
    // Use an equal-size fixture below to verify fractional paint independently.
  }

  @Test public void equalSpansThatFit_preserveFractionalPaint_andRepeatedCallArithmetic() throws Exception {
    SpannableString text = newText("W");
    TextPaint paint = newPaint(); paint.setTextSize(25.25f);
    for (int i=0; i<20; i++) {
      apply(text, paint, 10000f, Float.NaN, .68f);
      assertEquals(30, text.getSpans(0, 1, AbsoluteSizeSpan.class)[0].getSize());
      assertEquals(25.25f, paint.getTextSize(), 0.001f);
    }
  }

  private SpannableString mixed() throws Exception {
    SpannableString text = new SpannableString("WW");
    Class<?> span = Class.forName("com.facebook.react.views.text.internal.span.ReactAbsoluteSizeSpan");
    Constructor<?> ctor = span.getDeclaredConstructor(int.class); ctor.setAccessible(true);
    text.setSpan(ctor.newInstance(20), 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    text.setSpan(ctor.newInstance(60), 1, 2, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    return text;
  }

  private void apply(Spannable text, TextPaint paint, float height, float absolute, float scale)
      throws Exception {
    Method overload = fitter.getDeclaringClass().getDeclaredMethod("adjustSpannableFontToFit",
        Spannable.class, float.class, YogaMeasureMode.class, float.class, YogaMeasureMode.class,
        float.class, float.class, int.class, boolean.class, int.class, int.class,
        Layout.Alignment.class, int.class, TextPaint.class);
    overload.setAccessible(true);
    assertTrue(Modifier.isStatic(overload.getModifiers()));
    invoke(overload, null, text, 10000f, YogaMeasureMode.EXACTLY, height, YogaMeasureMode.EXACTLY,
        absolute, scale, 1, false, Layout.BREAK_STRATEGY_SIMPLE, Layout.HYPHENATION_FREQUENCY_NONE,
        Layout.Alignment.ALIGN_NORMAL, Layout.JUSTIFICATION_MODE_NONE, paint);
  }
}
