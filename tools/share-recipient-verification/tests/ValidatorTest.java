package app.captionstudio.verification.sharereceiver;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Arrays;

public final class ValidatorTest {
    private static int tests;
    private static final String CUE = "1\n00:00:00,000 --> 00:00:01,000\n";
    private static void expect(String name, String input, String error, int cues) {
        byte[] bytes = input.getBytes(StandardCharsets.UTF_8);
        Validator.Result result = Validator.inspect(bytes, bytes.length);
        check(name, result.error.equals(error) && result.cues == cues);
    }
    private static void check(String name, boolean ok) {
        if (!ok) throw new AssertionError(name);
        tests++;
        System.out.println("PASS " + name);
    }
    public static void main(String[] args) throws Exception {
        // First/Second/Third and Following cue are the expected source fixture
        // in tests/subtitle-srt-content-boundary.test.mjs at integration HEAD.
        byte[] fixture = Files.readAllBytes(Paths.get(args[0]));
        String expected = CUE + "First\nSecond\nThird\n\n2\n00:00:01,000 --> 00:00:02,000\nFollowing cue\n";
        check("expected source fixture bytes", Arrays.equals(fixture, expected.getBytes(StandardCharsets.UTF_8)));
        Validator.Result source = Validator.inspect(fixture, fixture.length);
        check("source fixture success and multiline", source.error.equals("NONE") && source.cues == 2 && source.bytes == fixture.length);
        check("SHA256 known vector", Validator.inspect(new byte[0], 0).sha256.equals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
        expect("ordinary success", CUE + "caption\n", "NONE", 1);
        expect("multiline Unicode and literal timestamps", CUE + "Caf\u00e9 \ud83d\udc4b\n  \u4e16\u754c  \n2\n00:00:01,000 --> 00:00:02,000\nsrc/app.ts https://example.invalid\n", "NONE", 1);
        expect("CRLF", expected.replace("\n", "\r\n"), "NONE", 2);
        expect("BOM", "\ufeff" + expected, "NONE", 2);
        expect("empty", "", "EMPTY", 0);
        expect("blank only", "\n \t\n", "NUMBER_SEQUENCE", 0);
        expect("malformed timing", "1\nbad\ncaption\n", "TIMESTAMP_SYNTAX", 0);
        expect("minute bounds", "1\n00:60:00,000 --> 00:61:00,000\ncaption\n", "TIMESTAMP_SYNTAX", 0);
        expect("reverse timing", "1\n00:00:02,000 --> 00:00:01,000\ncaption\n", "TIMESTAMP_ORDER", 0);
        expect("zero duration", "1\n00:00:00,000 --> 00:00:00,000\ncaption\n", "TIMESTAMP_ORDER", 0);
        expect("missing content", CUE, "EMPTY_CUE", 0);
        expect("premature blank", CUE + "First\n\nSecond\nThird\n", "PREMATURE_BLANK_OR_NUMBER", 1);
        expect("whitespace premature blank", CUE + "First\n \t\nSecond\n", "PREMATURE_BLANK_OR_NUMBER", 1);
        expect("missing separator", CUE + "First\n2\n00:00:01,000 --> 00:00:02,000\nFollowing cue\n", "NONE", 1);
        // Number/timestamp-looking caption lines are legal literal content.
        // Without a separator there is no second syntactic cue.
        expect("wrong first number", "2\n00:00:00,000 --> 00:00:01,000\ncaption\n", "NUMBER_SEQUENCE", 0);
        expect("sequence gap", CUE + "First\n\n3\n00:00:01,000 --> 00:00:02,000\nNext\n", "NUMBER_SEQUENCE", 1);
        expect("duplicate number", CUE + "First\n\n1\n00:00:01,000 --> 00:00:02,000\nNext\n", "NUMBER_SEQUENCE", 1);
        expect("NUL", CUE + "bad\u0000text\n", "CONTROL_CHARACTER", 0);
        expect("bare CR", CUE + "First\rSecond\n", "LINE_ENDING", 0);
        byte[] badUtf8 = {(byte) 0xc3, (byte) 0x28};
        check("malformed UTF8", Validator.inspect(badUtf8, badUtf8.length).error.equals("UTF8"));
        byte[] truncatedUtf8 = {(byte) 0xf0, (byte) 0x9f};
        check("truncated UTF8", Validator.inspect(truncatedUtf8, truncatedUtf8.length).error.equals("UTF8"));
        byte[] huge = new byte[Validator.MAX_BYTES + 1];
        check("oversize validator", Validator.inspect(huge, huge.length).error.equals("SIZE"));
        byte[] target = new byte[Validator.MAX_BYTES];
        check("bounded reader success", BoundedRead.read(new ByteArrayInputStream(fixture), target) == fixture.length && Arrays.equals(fixture, Arrays.copyOf(target, fixture.length)));
        final int[] consumed = {0};
        InputStream endless = new InputStream() {
            public int read() { consumed[0]++; return 65; }
            public int read(byte[] b, int offset, int count) {
                Arrays.fill(b, offset, offset + count, (byte) 65);
                consumed[0] += count;
                return count;
            }
        };
        try { BoundedRead.read(endless, target); throw new AssertionError("size bound"); }
        catch (BoundedRead.LimitReached expectedLimit) { check("reads at most 1MiB", consumed[0] == Validator.MAX_BYTES); }
        try { BoundedRead.read(new ByteArrayInputStream(target), target); throw new AssertionError("exact cap"); }
        catch (BoundedRead.LimitReached expectedLimit) { check("exact cap conservative rejection", true); }
        Thread.currentThread().interrupt();
        try { BoundedRead.read(new ByteArrayInputStream(fixture), target); throw new AssertionError("cancel"); }
        catch (java.io.InterruptedIOException expectedCancel) { check("cancellation", true); }
        finally { Thread.interrupted(); }
        InputStream zero = new InputStream() {
            public int read() { return -1; }
            public int read(byte[] b, int o, int n) { return 0; }
        };
        try { BoundedRead.read(zero, target); throw new AssertionError("zero progress"); }
        catch (IOException expectedZero) { check("no busy loop on zero progress", true); }
        System.out.println("TESTS_PASSED=" + tests);
        System.out.println("SOURCE_FIXTURE_BYTES=" + source.bytes);
        System.out.println("SOURCE_FIXTURE_SHA256=" + source.sha256);
    }
}
