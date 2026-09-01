# 历史地图集

基于 Leaflet 的中国历史地图 Web 应用。把历代都城格局与行政区划数据做成可自由叠加、对比、标注的图层，用于历史地理的教学与普及。

当前内置 **15 个数据集 / 49 个 GeoJSON 图层**，分 3 个分类：

| 分类 | 数据集 |
|---|---|
| 古代洛阳（7） | 隋唐洛阳-城、隋唐洛阳-西苑、汉魏洛阳-城、商洛阳-西亳城（偃师商城）、周洛阳-周王城、夏洛阳-斟鄩城（二里头）、其他要素-古代洛阳水系 |
| 古代北京（1） | 明清北京-城 |
| 历代行政区划（7） | 唐-734年、北魏-497年、北宋-1124年、南宋-1124年、元-1330年、东汉-189年、战国-前375年 |

---

## 快速开始

> ⚠️ **必须通过本地服务器访问，不能直接双击 `index.html`。**
> 浏览器出于安全策略会拦截 `file://` 下的 `fetch`，导致数据集列表为空、搜索不可用。
> （应用已内置检测：以 `file://` 打开时会自动弹出启动指引。）

在项目根目录任选一种方式启动：

```bash
# Python 3（无需安装任何依赖）
python -m http.server 8000

# Node.js
npx serve

# 或 VS Code 的 Live Server 插件
```

然后浏览器打开 <http://localhost:8000>。

无需构建、无需 `npm install`——所有依赖（Leaflet、FontAwesome 6.4、SortableJS、webfonts）都已本地化到 `js/vendor/` 与 `js/webfonts/`，**完全离线可用**。

---

## 功能特性

- **数据集 / 图层双视图**：顶部 Tab 切换。数据集视图按分类分组，可整组添加/移除；图层视图按数据集分组，支持拖拽排序
- **地图叠加对比**：任意数据集自由叠加，列表越靠上绘制层级越高；新添加的数据集默认置顶
- **分类分组**：古代洛阳 / 古代北京 / 历代行政区划，组头可折叠（折叠状态持久化）
- **搜索**：数据集名、完整介绍、分类名均可命中；图层视图内过滤图层，右上角另有地名搜索
- **图层控制**：显隐、缩放定位、数据集级整体隐藏、样式自定义（颜色/描边/透明度/点大小）、标注开关与字段选择
- **标注**：中文优先、文字正向，陡线自动竖排，标注默认色跟随图层图例色
- **测量**：测距、测面积（地图右侧工具栏）
- **底图切换**：Esri / OSM / OTM / 高德 等多种底图，跟随明暗主题
- **主题与响应式**：亮/暗主题，桌面端面板可拖拽调宽（220–560px），移动端为左侧抽屉
- **持久化**：图层顺序、分组折叠、面板宽度、主题偏好均存 localStorage

---

## 目录结构

```
├── index.html              # 页面骨架（脚本按依赖顺序引入）
├── css/
│   ├── base.css            # CSS 变量、Reset、滚动条、加载遮罩、侧边栏骨架与头尾
│   ├── map.css             # 地图区、测量工具、右下角控件、右侧工具栏、缩放控件
│   ├── panel.css           # 视图 Tab、统计条、数据集/图层两视图、图层项、拖拽、Toast
│   ├── responsive.css      # @media 断点适配
│   └── overlays.css        # hover 提示、样式/应用/作者弹窗、自定义下拉、取色器
├── js/
│   ├── config.js           # 全局配置：地图参数、底图、调色板
│   ├── colorUtils.js       # 颜色换算 + 应用内取色器（无业务依赖）
│   ├── uiWidgets.js        # UI 基础件：悬停提示、Toast、统一弹窗、复制、作者弹窗
│   ├── placeSearch.js      # 地点搜索：本地地名索引（离线可用）
│   ├── dataScanner.js      # 解析 manifest.json → 数据集列表
│   ├── mapManager.js       # Leaflet 地图实例、底图、缩放定位
│   ├── layerManager.js     # 图层加载/顺序/显隐/标注图层/统计
│   ├── uiManager.js        # 面板 UI：数据集与图层两视图、交互绑定
│   ├── measureTools.js     # 测距 / 测面积
│   ├── main.js             # 入口：初始化，默认加载首个数据集
│   ├── vendor/             # 本地化第三方库（Leaflet / Sortable / FA）
│   └── webfonts/           # 本地化字体
├── data/
│   ├── manifest.json       # 数据集清单（唯一的数据配置入口）
│   └── <朝代目录>/*.geojson
├── res/                    # favicon 等静态资源
└── tools/
    └── validate-data.js    # 数据校验脚本（见下）
```

模块全部使用 IIFE 私有命名空间 + 全局单例对象，依赖靠 `index.html` 里的 `<script>` 顺序保证：

```
config → colorUtils → uiWidgets → placeSearch → measureTools
       → dataScanner → mapManager → layerManager → uiManager → main
```

`colorUtils` / `uiWidgets` / `placeSearch` 不依赖任何业务模块，可独立复用；
`uiManager` 依赖前面全部模块。跨模块通信一律走全局单例对象（`LayerManager.xxx`、`UIWidgets.xxx`），
底层模块如需回调上层，用注册钩子（如 `UIWidgets.setBeforeOpenHook`）而非直接反向引用。

---

## 添加数据集

只需两步，无需改代码：

1. 把 GeoJSON 文件放到 `data/<目录>/`
2. 在 `data/manifest.json` 的 `datasets` 数组里加一条：

```json
{
  "name": "秦-前221年行政区划",
  "category": "历代行政区划",
  "info": "秦始皇二十六年（公元前221年）统一后的郡县设置。……",
  "files": [
    { "file": "秦/郡.geojson", "name": "郡", "style": { "fillColor": "#c59520", "fillOpacity": 0.28, "strokeWidth": 0.5 } },
    { "file": "秦/郡治.geojson", "name": "郡治", "style": { "pointColor": "#9b3adf", "pointSize": 6 } }
  ]
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 数据集名称，也是图层分组名 |
| `category` | ✅ | 分类名。未登记的分类会排在已登记分类之后；省略时按名称关键字推断（含「洛阳」「北京」「行政区划」） |
| `info` | 建议 | 完整介绍。列表不显示，鼠标悬停该数据集行时弹出 |
| `files[].file` | ✅ | 相对 `data/` 的路径 |
| `files[].name` | 可选 | 图层显示名，缺省由文件名推断 |
| `files[].style` | 可选 | 默认样式。含 `pointColor` 视为点图层，`lineColor` 视为线图层，`fillColor` 视为面图层 |

分类的展示顺序与图标在 `js/dataScanner.js` 的 `CATEGORY_ORDER` 和 `js/uiManager.js` 的 `categoryIcon()` 中登记。

### 数据校验

改动数据后运行：

```bash
node tools/validate-data.js
```

会检查：manifest 结构完整性、必填字段、文件路径存在、GeoJSON 可解析、几何类型与 style 推断一致、坐标是否落在中国经纬度范围内、有无重复 id。输出问题清单与汇总，退出码非 0 表示有问题（可挂到 CI）。

---

## 开发约定

### 缓存版本号（重要）

`index.html` 里所有本地 css/js 都带 `?v=R<N>`。

**任何 css/js 改动都必须把它 +1**（例如 `R161 → R162`），否则用户浏览器会用旧文件，出现「改了没生效」「功能异常」的假 bug——历史上为此排查过多次。

### 主题色

统一走 `LayerManager.getThemeColor(styleConfig, kind)` 取色（`point` → `pointColor`、`line` → `lineColor`、其余 → `fillColor || strokeColor`），不要直接读具体字段。主题蓝 `#4f6ef7`。

### 图层顺序

存 `localStorage['lyc_layer_order_v1']`，列表越靠上 = 绘制层级越高（`reapplyLayerOrder` 逆序移动 SVG path）。新添加的数据集默认置顶，所有数据集一视同仁，无「基准层」特殊待遇。

### 样式文件与级联顺序

CSS 按区块拆成 5 个文件，`index.html` 里的**引入顺序即级联顺序**，调整顺序会改变同权重规则的优先级：

```
base.css → map.css → panel.css → responsive.css → overlays.css
```

改动样式后建议跑一次视觉回归（见下），确认没有意外的样式回归。

### sticky 吸顶与容器 padding

凡 `position: sticky` 的分组头，其滚动容器**顶部 padding 必须为 0**，顶部间距改用首个分组的 `margin-top`。
否则 sticky 会吸在 padding 下沿，上方留出缝隙，滚动内容从缝隙穿出。
（见 `.layer-list-container` 与 `.dataset-list`。验证方法：滚动 1px 后对该区域截图，像素差异应为 0。）

### 按钮状态与局部刷新

改图层可见性后要调 `updateButtonsState()`；局部更新优先 `updateLayerItem(id)`，避免整表 `innerHTML` 重建。

---

## 已知约束

- **必须 HTTP 访问**（见「快速开始」），`file://` 下数据与搜索不可用
- 图层对象常驻内存，不做回收；单次会话内连续加载全部数据集会占用较多内存
- 测试需 `puppeteer-core` + 本机 Chrome（仓库不含 node_modules，`npm i puppeteer-core` 后可用）
- 行政区划数据集目前只有几何与治所点，暂无分级填色等专题图能力

---

## 回归测试

```bash
# 需先启动本地服务器（默认 http://localhost:8000）
node tests/e2e.js

# 指定地址
APP_URL=http://localhost:3000 node tests/e2e.js
```

依赖 `puppeteer-core` + 本机 Chrome，会跑一遍核心交互（分类分组、添加/移除、搜索、折叠、批量操作、图层视图、取色器、移动端、暗色模式、file:// 启动指引），输出通过/失败汇总，退出码非 0 表示有失败或 console 报错。改动 UI 后建议跑一次。

### 视觉回归

```bash
node tests/visual-regression.js --snapshot   # 改动样式前：拍基准图
node tests/visual-regression.js --check      # 改动样式后：逐像素比对
```

覆盖 5 个场景（数据集视图 / 滚动吸顶 / 图层视图 / 暗色模式 / 移动端抽屉），
基准图存 `tests/snapshots/`。地图瓦片与字体渲染存在极微小抖动，故允许
「差异字节 ≤ 200 且单通道差值 ≤ 4」的容差；真正的样式回归通常是成百上千字节的差异，会被捕获。
