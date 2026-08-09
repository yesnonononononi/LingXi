import os
from langchain_core.tools import tool
from langchain_tavily import TavilySearch


@tool("web_search")
def web_search(query: str) -> list:
    """Searches the web for information and returns a list of results.
    args: 需要搜索网络的内容
    """
    api_key = os.getenv("TAVILY_API_KEY")
    if api_key is None:
        raise Exception("请配置Tavily API KEY")
    tool_entity = TavilySearch(max_result=2, api_key=api_key)
    if query:
        return tool_entity.invoke(query)
    raise Exception("请输入有效问题")
