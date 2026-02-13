import os
import json
import requests
from datetime import datetime
from typing import Optional
from dotenv import load_dotenv

# 加载 .env 文件（从项目根目录）
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env'))

# 从环境变量读取配置
BASE_URL = os.getenv("API_BASE_URL", "http://127.0.0.1:5031")
TEST_TALKER = os.getenv("TEST_TALKER", "")
TEST_LIMIT = int(os.getenv("TEST_LIMIT", "100"))
TEST_START_DATE = os.getenv("TEST_START_DATE", "")
TEST_END_DATE = os.getenv("TEST_END_DATE", "")
TEST_CHATLAB = int(os.getenv("TEST_CHATLAB", "0"))

# 获取当前脚本所在目录
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# test 文件夹路径
TEST_DIR = SCRIPT_DIR


def save_json_to_test(data: dict, filename: Optional[str] = None) -> str:
    """
    将 JSON 数据保存到 test 文件夹
    
    Args:
        data: 要保存的数据
        filename: 文件名（不含路径），如果为 None 则自动生成
    
    Returns:
        保存的文件路径
    """
    if filename is None:
        # 自动生成文件名：messages_YYYYMMDD_HHMMSS.json
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"messages_{timestamp}.json"
    
    # 确保文件名安全
    filename = os.path.basename(filename)
    
    # 完整的保存路径
    filepath = os.path.join(TEST_DIR, filename)
    
    # 保存 JSON 文件
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    
    print(f"JSON 已保存到: {filepath}")
    return filepath


# 获取消息
messages = requests.get(f"{BASE_URL}/api/v1/messages", params={
    "talker": TEST_TALKER,
    "limit": TEST_LIMIT,
    "start": TEST_START_DATE,
    "end": TEST_END_DATE,
    "chatlab": TEST_CHATLAB
}).json()

print(messages)

# 保存 JSON 到 test 文件夹
save_json_to_test(messages)