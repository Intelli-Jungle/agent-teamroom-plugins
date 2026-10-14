"""pytest 公共夹具：临时数据目录与常用存储实例。

插件代码在本仓库，被测的 teamroom 核心在主仓库：TEAMROOM_REPO 环境变量
指向主仓库检出（缺省取与本仓库同级的 agent-teamroom 目录），加入 sys.path。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

TEAMROOM_REPO = Path(
    os.environ.get("TEAMROOM_REPO") or Path(__file__).resolve().parents[2] / "agent-teamroom"
)
sys.path.insert(0, str(TEAMROOM_REPO))

import pytest

from teamroom.config import AgentSpec, Config, PluginsConfig, RoomConfig, ServerConfig
from teamroom.core.registry import AgentRegistry
from teamroom.core.sessions import SessionStore
from teamroom.core.store import MessageStore
from teamroom.server.app import create_app

PLUGINS_DIR = Path(__file__).resolve().parent.parent / "plugins"


@pytest.fixture(autouse=True)
def _isolate_teamroom_home(tmp_path, monkeypatch):
    """隔离用户级插件目录（~/.teamroom 现参与插件扫描）：TEAMROOM_HOME 指向 tmp。"""
    monkeypatch.setenv("TEAMROOM_HOME", str(tmp_path / "teamroom-home"))


@pytest.fixture()
def data_dir(tmp_path):
    return tmp_path / "data"


@pytest.fixture()
def message_store(data_dir):
    return MessageStore(data_dir)


@pytest.fixture()
def session_store(data_dir, message_store):
    return SessionStore(data_dir, message_store=message_store)


@pytest.fixture()
def registry(data_dir):
    return AgentRegistry(data_dir)


@pytest.fixture()
def server_config(data_dir):
    """服务器测试配置：两个虚构 Agent 规格（无需真实安装）。

    本仓库其他插件（hello、msglog 等）的 prompt_extras 会干扰 workflow 的
    提示词顺序断言，测试中全部禁用，只保留 insights / workflow。"""
    return Config(
        server=ServerConfig(data_dir=str(data_dir)),
        room=RoomConfig(title="测试聊天室", history_limit=50),
        agents={
            "opencode": AgentSpec(
                name="opencode", command="opencode", label="OpenCode", color="#10a37f"
            ),
            "kiro": AgentSpec(
                name="kiro", command="kiro-cli", label="Kiro", color="#8b5cf6"
            ),
        },
        plugins=PluginsConfig(disabled=["hello", "msglog"]),
    )


@pytest.fixture()
def app(server_config):
    return create_app(server_config, plugins_dir=PLUGINS_DIR)


@pytest.fixture()
def app_state(app):
    return app.state.app_state


@pytest.fixture()
def client(app):
    from fastapi.testclient import TestClient

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(app_state):
    return {"X-Session-Token": app_state.session_token}
