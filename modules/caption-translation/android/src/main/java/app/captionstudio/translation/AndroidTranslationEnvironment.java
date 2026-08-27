package app.captionstudio.translation;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;

import java.io.File;
import java.util.Objects;

final class AndroidTranslationEnvironment implements TranslationEnvironment {
  private static final long MEBIBYTE = 1024L * 1024L;
  private static final long GIBIBYTE = 1024L * MEBIBYTE;
  private static final long MEMORY_HEADROOM_BYTES = 768L * MEBIBYTE;
  private static final long MINIMUM_TOTAL_MEMORY_BYTES = 4L * GIBIBYTE;
  private final Context context;

  AndroidTranslationEnvironment(Context context) {
    this.context = Objects.requireNonNull(context, "context").getApplicationContext();
  }

  @Override
  public File prepareCacheDirectory() throws NaturalCaptionTranslator.TranslationFailure {
    File cacheDirectory = new File(context.getCacheDir(), "natural-caption-translation");
    if ((cacheDirectory.exists() && !cacheDirectory.isDirectory())
        || (!cacheDirectory.exists() && !cacheDirectory.mkdirs())
        || !cacheDirectory.canWrite()) {
      throw new NaturalCaptionTranslator.TranslationFailure(
          NaturalCaptionTranslator.FAILED,
          "Caption Studio could not prepare local model storage."
      );
    }
    return cacheDirectory;
  }

  @Override
  public void verifyDeviceCapacity(File model) throws NaturalCaptionTranslator.TranslationFailure {
    if (Build.SUPPORTED_64_BIT_ABIS.length == 0) {
      throw unsupported("This device cannot run the local natural-language model.");
    }
    ActivityManager activityManager =
        (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
    if (activityManager == null) {
      throw unsupported("Caption Studio could not verify that this device can load the local model.");
    }
    ActivityManager.MemoryInfo memoryInfo = new ActivityManager.MemoryInfo();
    activityManager.getMemoryInfo(memoryInfo);
    long requiredAvailableBytes = saturatedAdd(model.length(), MEMORY_HEADROOM_BYTES);
    if (activityManager.isLowRamDevice()
        || memoryInfo.lowMemory
        || memoryInfo.totalMem < MINIMUM_TOTAL_MEMORY_BYTES
        || memoryInfo.availMem < requiredAvailableBytes) {
      throw unsupported(
          "This device does not currently have enough memory for local caption translation."
      );
    }
  }

  private static NaturalCaptionTranslator.TranslationFailure unsupported(String message) {
    return new NaturalCaptionTranslator.TranslationFailure(
        NaturalCaptionTranslator.UNSUPPORTED,
        message
    );
  }

  private static long saturatedAdd(long left, long right) {
    if (left > Long.MAX_VALUE - right) return Long.MAX_VALUE;
    return left + right;
  }
}
