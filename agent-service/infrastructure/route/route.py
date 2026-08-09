from langgraph.constants import END

from infrastructure.entity.state import State


def tool_route(state: State):
    if isinstance(state, list):  # 如果是列表,返回最后一个消息
        aiMessage = state[-1]

    elif messages := state.get("messages", []):  # 如果是字典,返回字典中的messages列表
        aiMessage = messages[-1]
    else:
        raise ValueError(f"No messages found in input state to tool_edge: {state}")
    if hasattr(aiMessage, "tool_calls") and len(aiMessage.tool_calls) > 0:
        return "attempt_tools"
    return END          #没有工具调用,返回结束
