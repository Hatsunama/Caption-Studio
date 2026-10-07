package app.captionstudio.verification.sharereceiver;

import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;

public final class BoundedRead {
    private BoundedRead() {}
    public static final class LimitReached extends IOException {}
    public static int read(InputStream in, byte[] target) throws IOException {
        if (target.length != Validator.MAX_BYTES) throw new IllegalArgumentException("capacity");
        int count = 0;
        while (count < target.length) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException();
            int n = in.read(target, count, Math.min(8192, target.length - count));
            if (n < 0) return count;
            if (n == 0) throw new IOException("NO_PROGRESS");
            count += n;
        }
        // No extra EOF-probe byte: reject exact capacity as well as larger input.
        throw new LimitReached();
    }
}
