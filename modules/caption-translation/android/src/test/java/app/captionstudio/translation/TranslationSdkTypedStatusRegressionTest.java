package app.captionstudio.translation;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.google.ai.edge.litertlm.*;
import java.util.concurrent.CancellationException;
import org.junit.Test;

/** The pre-repair adapter executes here: the synchronous path loses the typed SDK status. */
public class TranslationSdkTypedStatusRegressionTest {
  @Test public void productionAdapterUsesTheSdkTypedCancellationCallback() throws Exception {
    Engine engine = mock(Engine.class);
    Conversation conversation = mock(Conversation.class);
    when(engine.createConversation(any(ConversationConfig.class))).thenReturn(conversation);
    when(engine.isInitialized()).thenReturn(true);
    LiteRtLmJniException synchronousFailure = new LiteRtLmJniException("opaque JNI failure");
    when(conversation.sendMessage(anyString(), anyMap(), isNull(), isNull(), isNull(),
        isNull(), isNull(), any(ResponseFormat.class))).thenThrow(synchronousFailure);
    doAnswer(invocation -> {
      TranslationSdkCancellationAdapterTest.sdkError(invocation.getArgument(1), 1);
      return null;
    }).when(conversation).sendMessageAsync(anyString(), any(MessageCallback.class), anyMap(),
        isNull(), isNull(), isNull(), anyInt(), isNull(), any(ResponseFormat.class));

    TranslationRuntime runtime = new LiteRtLmTranslationRuntime(
        engine, TranslationSdkCancellationAdapterTest.config());
    try {
      assertThrows(CancellationException.class, () ->
          runtime.translate("PROMPT", 296, true, TranslationSdkCancellationAdapterTest.SCHEMA));
      verify(conversation).sendMessageAsync(eq("PROMPT"), any(MessageCallback.class), anyMap(),
          isNull(), isNull(), isNull(), eq(296), isNull(),
          eq(ResponseFormat.json(TranslationSdkCancellationAdapterTest.SCHEMA)));
      verify(conversation).close();
    } finally {
      runtime.close();
    }
  }
}
