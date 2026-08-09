import json

from langchain_core.messages import ToolMessage, AIMessage, ToolCall
from langchain_core.tools import BaseTool

from infrastructure.tools.Tool import tools


class BaseToolNode:
    def __init__(self,tools:list[BaseTool]):
        self.tool_by_name = {tool.name: tool for tool in tools}

    def __call__(self, inputs:dict) -> dict[str,list]:
        message = self._resolveMessage(inputs)
        outputs = []
        for tool_call in message.tool_calls:
            if tool := self.tool_by_name[tool_call["name"]]:
                response = tool.invoke(tool_call["args"])
                outputs.append(self._buildToolMessage(response,tool_call))
        return {"messages":outputs}

    #addMessages -> BaseMessage (HumanMessage,AIMessage,ToolMessage)

    def _resolveMessage(self,inputs:dict) -> AIMessage:
        messages = inputs.get("messages",[])
        if messages :
           return isinstance(messages[-1],AIMessage) and [] or messages[-1]
        raise Exception("请输入有效问题")
    def _buildToolMessage(self,response:str,toolEntity:ToolCall) -> ToolMessage:
        try:
            return ToolMessage(
                tool_call_id=toolEntity["id"],
                content= json.dumps(response),
                name  = toolEntity["name"],
            )
        except Exception as e:
            raise Exception(f"构造工具响应失败{response}") from e

baseToolNode= BaseToolNode(tools=tools.getTools())