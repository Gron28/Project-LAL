import unittest

from scripts.openvino_npu_server import NpuRuntime, normalize_messages, text_content


class OpenVinoNpuServerTests(unittest.TestCase):
    def test_text_content_flattens_openai_text_parts(self):
        self.assertEqual(
            text_content([
                {"type": "text", "text": "first"},
                {"type": "image_url", "image_url": {"url": "ignored"}},
                {"type": "text", "text": "second"},
            ]),
            "first\nsecond",
        )

    def test_disable_thinking_marks_only_last_user_message(self):
        messages = normalize_messages(
            [
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": "answer"},
                {"role": "user", "content": "latest  "},
            ],
            disable_thinking=True,
        )
        self.assertEqual(messages[0]["content"], "first")
        self.assertEqual(messages[2]["content"], "latest /no_think")

    def test_generation_options_are_openvino_genai_compatible(self):
        self.assertEqual(
            NpuRuntime.generation_options({
                "max_tokens": 64,
                "temperature": 0.2,
                "top_p": 0.9,
                "top_k": 20,
                "repeat_penalty": 1.1,
            }),
            {
                "max_new_tokens": 64,
                "do_sample": True,
                "temperature": 0.2,
                "top_p": 0.9,
                "top_k": 20,
                "repetition_penalty": 1.1,
            },
        )


if __name__ == "__main__":
    unittest.main()
