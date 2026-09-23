package app.captionstudio.translation;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CancellationException;

/** Worker-confined counters. Never retains prompts, responses, IDs, paths, or exceptions. */
final class TranslationBatchMetrics {
  private final long started = System.nanoTime();
  private final int batchIndex;
  private final int captionCount;
  private String backend = "none";
  private boolean fallback;
  long initializationNanos;
  private long generationNanos;
  private int attempts;
  private int repairAttempts;
  private int generationFailures;
  private int invalidOutputs;
  private int qualityRejections;
  private boolean cancelled;

  TranslationBatchMetrics(int batchIndex, int captionCount) {
    this.batchIndex = batchIndex;
    this.captionCount = captionCount;
  }

  String generate(TranslationRuntime runtime, String prompt, int tokens, boolean repair)
      throws Exception {
    backend = safeBackend(runtime.backendName());
    fallback = runtime.initializationFallback();
    attempts++;
    if (repair) repairAttempts++;
    long start = System.nanoTime();
    try {
      return runtime.translate(prompt, tokens);
    } catch (Exception | Error failure) {
      generationFailures++;
      cancelled = failure instanceof CancellationException || failure instanceof InterruptedException;
      throw failure;
    } finally {
      generationNanos += Math.max(0, System.nanoTime() - start);
    }
  }

  void reject(boolean structurallyValid) {
    if (structurallyValid) qualityRejections++;
    else invalidOutputs++;
  }

  Map<String, Object> finish(boolean completed, boolean cancellationRequested) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("batchIndex", batchIndex);
    values.put("captionCount", captionCount);
    values.put("backend", backend);
    values.put("initializationFallback", fallback);
    values.put("durationMs", Math.max(0, System.nanoTime() - started) / 1_000_000L);
    values.put("initializationMs", initializationNanos / 1_000_000L);
    values.put("generationMs", generationNanos / 1_000_000L);
    values.put("attempts", attempts);
    values.put("repairAttempts", repairAttempts);
    values.put("generationFailures", generationFailures);
    values.put("invalidOutputs", invalidOutputs);
    values.put("qualityRejections", qualityRejections);
    values.put("outcome", cancelled || cancellationRequested ? "cancelled" : completed ? "completed" : "failed");
    return values;
  }

  static String safeBackend(String backend) {
    return "cpu".equals(backend) || "gpu".equals(backend) || "none".equals(backend)
        ? backend : "unknown";
  }
}
