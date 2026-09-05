package app.captionstudio.translation;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;

import java.io.File;
import java.util.Objects;

final class AndroidTranslationEnvironment implements TranslationEnvironment {
  private static final long GIBIBYTE = 1024L * 1024L * 1024L;
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
    boolean supports64Bit = Build.SUPPORTED_64_BIT_ABIS.length > 0;
    if (!supports64Bit) {
      throw unsupported("This device cannot run the local natural-language model.");
    }
    ActivityManager activityManager =
        (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
    if (activityManager == null) {
      throw unsupported("Caption Studio could not verify that this device can load the local model.");
    }
    ActivityManager.MemoryInfo memoryInfo = new ActivityManager.MemoryInfo();
    activityManager.getMemoryInfo(memoryInfo);
    if (!hasHardwareCapacity(
        supports64Bit,
        activityManager.isLowRamDevice(),
        memoryInfo.totalMem
    )) {
      throw unsupported(
          "Local caption translation requires a 64-bit Android device with at least 4 GB of RAM."
      );
    }
  }

  @Override
  public File prepareCheckpointDirectory() {
    // Unlike cacheDir, this survives process death and Android cache eviction.
    // noBackupFilesDir keeps subtitle text out of cloud/device backups.
    return new File(context.getNoBackupFilesDir(), "caption-translation-checkpoints-v1");
  }

  static boolean hasHardwareCapacity(
      boolean supports64Bit,
      boolean lowRamDevice,
      long totalMemoryBytes
  ) {
    // Do not reject on MemoryInfo.lowMemory or availMem. Both are transient,
    // and the LiteRT-LM model is memory-mapped rather than copied wholesale
    // into resident RAM. The runtime is the authoritative allocation test.
    return supports64Bit
        && !lowRamDevice
        && totalMemoryBytes >= MINIMUM_TOTAL_MEMORY_BYTES;
  }

  private static NaturalCaptionTranslator.TranslationFailure unsupported(String message) {
    return new NaturalCaptionTranslator.TranslationFailure(
        NaturalCaptionTranslator.UNSUPPORTED,
        message
    );
  }

}
