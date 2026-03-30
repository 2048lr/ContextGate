"""
测试用例 - 确保清洗逻辑不误杀
"""

import pytest
from app.proxy import RequestSanitizer


class TestRequestSanitizer:
    """请求清洗器测试"""
    
    def setup_method(self):
        self.sanitizer = RequestSanitizer()
    
    def test_sanitize_api_key(self):
        """测试 API Key 清洗"""
        text = "api_key = 'sk-1234567890abcdefghijklmnopqrstuvwxyz123456'"
        result = self.sanitizer.sanitize_string(text)
        assert "[REDACTED]" in result
        assert "sk-1234567890abcdefghijklmnopqrstuvwxyz123456" not in result
    
    def test_sanitize_password(self):
        """测试密码清洗"""
        text = 'password = "my_secret_password"'
        result = self.sanitizer.sanitize_string(text)
        assert "[REDACTED]" in result
        assert "my_secret_password" not in result
    
    def test_sanitize_token(self):
        """测试 Token 清洗"""
        text = 'token: "bearer_token_here"'
        result = self.sanitizer.sanitize_string(text)
        assert "[REDACTED]" in result
    
    def test_sanitize_dict(self):
        """测试字典清洗"""
        data = {
            "api_key": "sk-1234567890abcdefghijklmnopqrstuvwxyz123456",
            "model": "gpt-4",
            "password": "secret123"
        }
        result = self.sanitizer.sanitize_dict(data)
        
        assert "[REDACTED]" in result["api_key"]
        assert result["model"] == "gpt-4"
        assert "[REDACTED]" in result["password"]
    
    def test_sanitize_nested_dict(self):
        """测试嵌套字典清洗"""
        data = {
            "config": {
                "api_key": "sk-1234567890abcdefghijklmnopqrstuvwxyz123456",
                "settings": {
                    "token": "my_token"
                }
            },
            "name": "test"
        }
        result = self.sanitizer.sanitize_dict(data)
        
        assert "[REDACTED]" in result["config"]["api_key"]
        assert "[REDACTED]" in result["config"]["settings"]["token"]
        assert result["name"] == "test"
    
    def test_sanitize_list(self):
        """测试列表清洗"""
        data = [
            "normal text",
            "api_key = 'sk-1234567890abcdefghijklmnopqrstuvwxyz123456'",
            {"password": "secret"}
        ]
        result = self.sanitizer.sanitize_list(data)
        
        assert result[0] == "normal text"
        assert "[REDACTED]" in result[1]
        assert "[REDACTED]" in result[2]["password"]
    
    def test_no_false_positives(self):
        """测试不会误杀正常内容"""
        normal_texts = [
            "This is a normal message about API usage",
            "The model is gpt-4-turbo",
            "Please set your configuration",
            "User authentication required"
        ]
        
        for text in normal_texts:
            result = self.sanitizer.sanitize_string(text)
            assert result == text, f"False positive detected: {text}"
    
    def test_preserve_code_structure(self):
        """测试保留代码结构"""
        code = '''
def get_config():
    return {
        "model": "gpt-4",
        "temperature": 0.7,
        "max_tokens": 1000
    }
        '''
        result = self.sanitizer.sanitize_string(code)
        assert "def get_config():" in result
        assert '"model": "gpt-4"' in result
        assert '"temperature": 0.7' in result
