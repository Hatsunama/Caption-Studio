package app.captionstudio.translation;

import com.google.ai.edge.litertlm.BenchmarkInfo;
import com.google.ai.edge.litertlm.ConversationConfig;
import com.google.ai.edge.litertlm.MessageCallback;
import com.google.ai.edge.litertlm.ResponseFormat;

/** Engine owns native resources; the adapter owns sequencing and terminal lifecycle. */
interface TranslationSdkGateway {
  Session createConversation(ConversationConfig config);
  boolean isInitialized();
  void close();

  interface Session {
    void sendMessageAsync(String prompt, MessageCallback callback, int maxOutputTokens,
        ResponseFormat responseFormat);
    void cancelProcess();
    BenchmarkInfo getBenchmarkInfo();
    void close();
  }
}
