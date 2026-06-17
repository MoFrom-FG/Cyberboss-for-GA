# Vision API SOP

## ⚠️ 前置规则（必须遵守）

1. **先枚举窗口**：调用 vision 前必须先用 `pygetwindow` 枚举窗口标题，确认目标窗口存在且已激活到前台。窗口不存在就不要截图。
2. **🚫 禁止全屏截图**：必须先利用ljqCtrl截取窗口区域。能截局部（如标题栏）就不截整窗口，能截窗口就绝不全屏。全屏截图在任何场景下都不允许。
3. **能不用 vision 就不用**：如果窗口标题/本地 OCR（`ocr_utils.py`）能获取所需信息，就不要调用 vision API，省 token 且更可靠。Vision 是最后手段。

## 快速用法

```python
from vision_api import ask_vision
result = ask_vision(image, prompt="描述图片内容", timeout=60, max_pixels=1_440_000)
# image: 文件路径(str/Path) 或 PIL Image
# backend: 'claude'(默认) | 'openai' | 'modelscope'
# 返回 str：成功为模型回复，失败为 'Error: ...'
```

## 截图实现（窗口捕获）
- **优先 PIL+win32gui**：`mss` 可能未装，PIL+win32gui 是可靠替代。详见下方代码模板。
- **窗口识别**：目标浏览器标题可能是 `Codex`（主窗口），`pygetwindow.getWindowsWithTitle('Codex')` 定位。
- **全屏禁止**：只能截窗口/客户区，禁止全屏。

```python
import pygetwindow as gw, win32gui, win32ui, win32con
from PIL import Image
wins = gw.getWindowsWithTitle('目标窗口标题')
win = wins[0]
win.activate()
hwnd = win._hWnd
origin = win32gui.ClientToScreen(hwnd, (0,0))
dc = win32gui.GetWindowDC(hwnd)
mfc = win32ui.CreateDCFromHandle(dc)
save = mfc.CreateCompatibleDC()
bmp = win32ui.CreateBitmap()
bmp.CreateCompatibleBitmap(mfc, w, h)
save.SelectObject(bmp)
save.BitBlt((0,0), (w,h), mfc, (0,0), win32con.SRCCOPY)
img = Image.frombuffer('RGB', (w,h), bmp.GetBitmapBits(True), 'raw', 'BGRX', 0, 1)
img.save(path)
# 清理 DC/bmp 对象
```
