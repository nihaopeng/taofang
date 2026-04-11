from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
import uvicorn

async def homepage(request):
    return PlainTextResponse("Hello, World!")

app = Starlette(debug=True, routes=[
    Route("/", homepage),
])

if __name__ == "__main__":
    print("Starting simple Starlette app on port 8888...")
    uvicorn.run(app, host="127.0.0.1", port=8888, log_level="info")