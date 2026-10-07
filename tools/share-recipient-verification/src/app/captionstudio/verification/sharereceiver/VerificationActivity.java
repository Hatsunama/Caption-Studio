package app.captionstudio.verification.sharereceiver;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.widget.TextView;
import java.io.InputStream;
import java.util.Arrays;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

public final class VerificationActivity extends Activity {
    private static final ThreadPoolExecutor WORKER = new ThreadPoolExecutor(
        0, 1, 5, TimeUnit.SECONDS, new SynchronousQueue<Runnable>());
    private static volatile String evidence = unknown("NO_STREAM");
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextView display;
    private Request active;
    private static final class Request {
        final CancellationSignal signal = new CancellationSignal();
        volatile boolean cancelled;
        Future<?> future;
        Runnable timeout;
    }
    private static String unknown(String error) {
        return "Bytes: unavailable\nSHA256: unavailable\nCue count: unavailable\nError: " + error;
    }
    @Override public void onCreate(Bundle ignored) {
        super.onCreate(null);
        display = new TextView(this);
        display.setSaveEnabled(false);
        display.setTextSize(18);
        display.setPadding(24, 48, 24, 24);
        setContentView(display);
        accept(getIntent());
    }
    @Override protected void onNewIntent(Intent incoming) {
        super.onNewIntent(incoming);
        accept(incoming);
    }
    private void show(String value) { evidence = value; display.setText(value); }
    @SuppressWarnings("deprecation")
    private void accept(Intent incoming) {
        // Do not retain EXTRA_STREAM/ClipData in this Activity's stored Intent.
        setIntent(new Intent());
        if (active != null) cancel("CANCELLED");
        if (incoming == null || Intent.ACTION_MAIN.equals(incoming.getAction())) {
            display.setText(evidence);
            return;
        }
        try {
            if (!Intent.ACTION_SEND.equals(incoming.getAction())) { show(unknown("ACTION")); return; }
            Object stream = incoming.getParcelableExtra(Intent.EXTRA_STREAM);
            if (!(stream instanceof Uri)) { show(unknown("NO_STREAM")); return; }
            final Uri uri = (Uri) stream;
            if (!"content".equals(uri.getScheme()) || uri.getAuthority() == null || uri.getAuthority().isEmpty()) {
                show(unknown("URI_SCHEME")); return;
            }
            if ((incoming.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0
                || checkUriPermission(uri, Process.myPid(), Process.myUid(),
                    Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
                show(unknown("READ_GRANT")); return;
            }
            final Request request = new Request();
            active = request;
            show(unknown("WAITING_1500MS"));
            request.timeout = new Runnable() {
                @Override public void run() { if (active == request) cancel("TIMEOUT"); }
            };
            main.postDelayed(request.timeout, 12000);
            try {
                request.future = WORKER.submit(new Runnable() {
                    @Override public void run() { consume(uri, request); }
                });
            } catch (RejectedExecutionException busy) {
                active = null;
                main.removeCallbacks(request.timeout);
                show(unknown("BUSY"));
            }
        } catch (RuntimeException malformed) { show(unknown("INTENT")); }
    }
    private void consume(Uri uri, Request request) {
        byte[] bytes = null;
        String result = unknown("READ_FAILED");
        try {
            Thread.sleep(1500);
            if (request.cancelled) return;
            bytes = new byte[Validator.MAX_BYTES];
            // Only the exact EXTRA_STREAM URI is opened, read-only, with its grant.
            // The descriptor supports provider cancellation; neither URI nor text is logged.
            try (AssetFileDescriptor descriptor = getContentResolver()
                    .openAssetFileDescriptor(uri, "r", request.signal)) {
                if (descriptor == null) throw new java.io.IOException();
                try (InputStream stream = descriptor.createInputStream()) {
                    int count = BoundedRead.read(stream, bytes);
                    if (request.cancelled) return;
                    result = Validator.inspect(bytes, count).evidence();
                }
            }
        } catch (BoundedRead.LimitReached limit) { result = unknown("SIZE_LIMIT_REACHED"); }
        catch (InterruptedException | java.io.InterruptedIOException cancelled) { result = unknown("CANCELLED"); }
        catch (SecurityException grant) { result = unknown("READ_GRANT"); }
        catch (java.io.IOException | RuntimeException failure) { result = unknown("READ_FAILED"); }
        finally { if (bytes != null) Arrays.fill(bytes, (byte) 0); }
        final String finished = result;
        main.post(new Runnable() {
            @Override public void run() {
                if (!request.cancelled && active == request && !isFinishing() && !isDestroyed()) {
                    main.removeCallbacks(request.timeout);
                    active = null;
                    show(finished);
                }
            }
        });
    }
    private void cancel(String reason) {
        Request request = active;
        active = null;
        if (request == null) return;
        request.cancelled = true;
        main.removeCallbacks(request.timeout);
        if (request.future != null) request.future.cancel(true);
        show(unknown(reason));
        request.signal.cancel();
    }
    @Override protected void onStop() { cancel("CANCELLED"); super.onStop(); }
    @Override protected void onDestroy() { cancel("CANCELLED"); super.onDestroy(); }
    @Override protected void onSaveInstanceState(Bundle out) {
        // No raw bytes, captions, URI, or evidence serialized to disk-backed state.
    }
}
