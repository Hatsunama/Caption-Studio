package app.captionstudio.translation;

import com.google.ai.edge.litertlm.Message;
import com.google.ai.edge.litertlm.MessageCallback;
import java.util.concurrent.CancellationException;

/** Callback collection only. Runs no tasks and never releases ownership before a terminal callback. */
final class TranslationMessageBridge implements MessageCallback {
  private static final int MAX_RESPONSE_CHARACTERS = 1_048_576;
  private final StringBuilder response = new StringBuilder();
  private boolean terminal, dispatched, cancellationSignalled, cancellationInFlight;
  private Throwable nativeFailure, collectionFailure, cancellationFailure;

  @Override public synchronized void onMessage(Message message) {
    if (terminal || collectionFailure != null) return;
    try {
      // SDK Message.toString is the raw text of this chunk, not a cumulative response.
      String chunk = message.toString();
      if (chunk.length() > MAX_RESPONSE_CHARACTERS - response.length()) {
        collectionFailure = new IllegalStateException("LiteRT-LM response exceeds the adapter buffer limit");
        response.setLength(0);
      } else {
        response.append(chunk);
      }
    } catch (Throwable failure) {
      collectionFailure = failure;
      response.setLength(0);
    }
  }

  @Override public synchronized void onDone() {
    if (terminal) return;
    terminal = true;
    notifyAll();
  }

  @Override public synchronized void onError(Throwable failure) {
    if (terminal) return;
    nativeFailure = failure;
    terminal = true;
    notifyAll();
  }

  synchronized void markDispatched() {
    dispatched = true;
    notifyAll();
  }

  synchronized boolean claimCancellation() {
    if (!dispatched || terminal || cancellationSignalled) return false;
    cancellationSignalled = true;
    cancellationInFlight = true;
    return true;
  }

  synchronized void recordCancellationFailure(Throwable failure) {
    cancellationFailure = failure;
  }

  synchronized void finishCancellation() {
    cancellationInFlight = false;
    notifyAll();
  }

  String awaitTerminal(Runnable retryCancellation) throws Throwable {
    InterruptedException interruption = null;
    for (;;) {
      retryCancellation.run();
      synchronized (this) {
        if (terminal && !cancellationInFlight) break;
        try {
          // This is a lock-contention retry interval, not a generation deadline.
          wait(25L);
        } catch (InterruptedException caught) {
          if (interruption == null) interruption = caught;
        }
      }
    }
    if (interruption != null) Thread.currentThread().interrupt();
    synchronized (this) {
      Throwable failure = nativeFailure;
      if (failure == null || failure instanceof CancellationException) {
        if (cancellationFailure != null) failure = cancellationFailure;
        else if (collectionFailure != null) failure = collectionFailure;
      }
      if (failure == null) failure = interruption;
      if (failure != null) {
        if (cancellationFailure != null && cancellationFailure != failure)
          failure.addSuppressed(cancellationFailure);
        if (collectionFailure != null && collectionFailure != failure)
          failure.addSuppressed(collectionFailure);
        if (nativeFailure != null && nativeFailure != failure)
          failure.addSuppressed(nativeFailure);
        throw failure;
      }
      return response.toString();
    }
  }
}
