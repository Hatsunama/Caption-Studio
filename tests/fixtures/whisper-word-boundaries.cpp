// Native types above and algorithms below are extracted verbatim from installed
// whisper.rn; only the context/state and token vocabulary accessors are stubs.
struct whisper_context { std::vector<std::string> vocabulary; };
struct whisper_state { std::vector<whisper_segment> result_all; };
static int whisper_token_eot(whisper_context *) { return 100000; }
static const char * whisper_token_to_str(whisper_context * ctx, whisper_token id) {
    return ctx->vocabulary.at(id).c_str();
}
// EXTRACTED_FUNCTIONS

using Wrap = int (*)(whisper_context &, whisper_state &, int, bool);
static void check(bool ok, const std::string & message) {
    if (!ok) { std::cerr << "FAIL: " << message << '\n'; std::exit(1); }
}
static whisper_state run(Wrap wrap, const std::vector<std::string> & words,
                         const std::vector<int64_t> & times, int64_t start = 350,
                         int64_t end = 500, bool on_word = false, int max_len = 1) {
    whisper_context ctx{words};
    whisper_segment parent{}; parent.t0 = start; parent.t1 = end;
    parent.speaker_turn_next = true;
    for (size_t i = 0; i < words.size(); ++i) {
        size_t id = 0; while (words.at(id) != words[i]) ++id;
        whisper_token_data tok{}; tok.id = (int) id; tok.t0 = times.at(i); tok.t1 = times.at(i);
        parent.tokens.push_back(tok); parent.text += words[i];
    }
    whisper_state state{{parent}};
    const int count = wrap(ctx, state, max_len, on_word);
    check(count == (int) state.result_all.size(), "return count");
    std::string text; size_t index = 0;
    for (size_t i = 0; i < state.result_all.size(); ++i) {
        const auto & seg = state.result_all[i]; text += seg.text;
        check(seg.speaker_turn_next == (i + 1 == state.result_all.size()), "speaker flag");
        for (const auto & tok : seg.tokens) {
            size_t id = 0; while (words.at(id) != words.at(index)) ++id;
            check(tok.id == (int) id && tok.t0 == times.at(index) && tok.t1 == times.at(index), "token order and unchanged timestamps");
            ++index;
        }
    }
    check(index == words.size() && text == parent.text, "byte-exact text and token conservation");
    return state;
}
static void bounded(const whisper_state & state, int64_t start = 350, int64_t end = 500) {
    int64_t previous = start;
    for (const auto & seg : state.result_all) {
        check(seg.t0 == previous && seg.t0 >= start && seg.t1 <= end && seg.t0 < seg.t1, "positive bounded contiguous native intervals");
        previous = seg.t1;
    }
    check(previous == end, "parent endpoint unchanged");
}
static void equivalent(const whisper_state & a, const whisper_state & b) {
    check(a.result_all.size() == b.result_all.size(), "normal split count unchanged");
    for (size_t i = 0; i < a.result_all.size(); ++i) {
        const auto & x = a.result_all[i]; const auto & y = b.result_all[i];
        check(x.t0 == y.t0 && x.t1 == y.t1 && x.text == y.text &&
              x.speaker_turn_next == y.speaker_turn_next && x.tokens.size() == y.tokens.size(), "normal strict-interior exact equivalence");
        for (size_t j = 0; j < x.tokens.size(); ++j)
            check(x.tokens[j].id == y.tokens[j].id && x.tokens[j].t0 == y.tokens[j].t0 && x.tokens[j].t1 == y.tokens[j].t1, "normal tokens unchanged");
    }
}
int main(int argc, char **) {
    const bool baseline = argc > 1;
    Wrap wrap = baseline ? baseline_wrap_segment : whisper_wrap_segment;
    // Synthetic token sequence reproduces observed Samsung segments 12/13,
    // each [400,400] in 10ms units. Diagnostic contains no original token text.
    const auto repeated = run(wrap, {" one", " two", " two", " three", " four"}, {350,400,400,400,450});
    std::cout << (baseline ? "BASELINE " : "CANDIDATE ");
    for (const auto & seg : repeated.result_all) std::cout << '[' << seg.t0 << ',' << seg.t1 << "] ";
    std::cout << '\n';
    bounded(repeated);
    check(repeated.result_all.size() == 3 && repeated.result_all[1].text == " two two three", "repeated times retain text until real boundary");
    for (const auto & times : std::vector<std::vector<int64_t>>{
             {350,-1,300,500,501,450}, {350,400,390,400,501,450},
             {350,350,350,350,350,350}, {350,600,500,-9,349,450},
             {350,INT64_MIN,INT64_MAX,400,400,500}})
        bounded(run(wrap, {"a", " ", u8"é", u8"中文", ",!", "again"}, times));
    for (bool word : {false, true}) for (int limit : {1, 4, 100}) {
        const std::vector<std::string> words{"a", " ", u8"é", u8"中文", ",!", " again"};
        const std::vector<int64_t> times{350,375,400,425,450,475};
        const auto actual = run(wrap, words, times, 350,500,word,limit);
        bounded(actual);
        equivalent(actual, run(baseline_wrap_segment, words,times,350,500,word,limit));
    }
    for (const auto & bounds : std::vector<std::pair<int64_t,int64_t>>{{400,400}, {500,400}, {-20,100}}) {
        const auto invalid = run(wrap, {"a", " b"}, {bounds.first,bounds.first}, bounds.first,bounds.second);
        check(invalid.result_all.size() == 1 && invalid.result_all[0].t0 == bounds.first && invalid.result_all[0].t1 == bounds.second, "invalid original parent remains invalid, never fabricated");
    }
    const auto negative = run(wrap, {"a", " b"}, {-20,50}, -20,100);
    check(negative.result_all.front().t0 == -20 && negative.result_all.back().t1 == 100,
          "negative original parent is still invalid after an interior split");
    std::cout << "PASS native boundary, conservation, Unicode, normal-equivalence and invalid-parent cases\n";
}
