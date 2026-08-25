/**
 * 全局配置
 */

const CONFIG = {
    // ---------- 地图默认参数 ----------
    map: {
        center: [34.71, 112.55],
        zoom: 12,
        minZoom: 3,
        maxZoom: 19,
    },

    // ---------- 底图配置 ----------
    baseLayers: {
        'Esri冷色地图': {
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
            options: { maxZoom: 18, attribution: '© Esri' },
            icon: 'fa-fill-drip'
        },
        // R60：精选自 CSDN「25 个在线地图瓦片 URL 分享」博客（腾讯地图连接失败已剔除）
        'Esri暗黑地图': {
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
            options: { maxZoom: 18, attribution: '© Esri' },
            icon: 'fa-moon'
        },
        'Esri地形图': {
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
            options: { maxZoom: 18, attribution: '© Esri' },
            icon: 'fa-mountain'
        },
        'Esri影像': {
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            options: { maxZoom: 19, attribution: '© Esri World Imagery' },
            icon: 'fa-satellite'
        },
        'OSM街道地图': {
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            options: { maxZoom: 19, attribution: '© OpenStreetMap contributors' },
            icon: 'fa-map'
        },
        'OTM等高线地形图': {
            url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
            options: { maxZoom: 17, attribution: '© OpenTopoMap (CC-BY-SA)', subdomains: 'abc' },
            icon: 'fa-mountain-sun'
        },
        '高德影像（有偏）': {
            url: 'https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
            options: { maxZoom: 18, attribution: '© 高德地图' },
            icon: 'fa-satellite'
        },
        '高德街道（有偏）': {
            url: 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
            options: { maxZoom: 18, attribution: '© 高德地图' },
            icon: 'fa-road'
        },
        '空白底图': {
            url: '',
            options: {},
            icon: 'fa-square'
        }
    },

    defaultBaseLayer: 'Esri冷色地图',

    // ---------- 数据源配置（由 manifest.json 加载） ----------
    dataSources: [],

    // ---------- 颜色调色板 ----------
    colorPalette: [
        '#4f6ef7', '#ef4444', '#10b981', '#8b5cf6', '#f59e0b',
        '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
        '#06b6d4', '#d946ef', '#22c55e', '#e11d48', '#0ea5e9',
    ],

    // ---------- 作者信息（导航栏右侧「关于作者」头像按钮弹出） ----------
    author: {
        name: '洛',
        tagline: '历史地图 · 数字人文',
        bio: '以交互地图为载体，整理与呈现历史城池、水系、疆域变迁等主题的地理信息，让历史在空间上被看见。',
        details: [
            { icon: 'fa-book-open', label: '内容主题', value: '历史城池 · 水系 · 区域变迁' },
            { icon: 'fa-map-location-dot', label: '呈现形式', value: '交互式历史地图集' },
            { icon: 'fa-palette', label: '设计理念', value: '地图即叙事，数据可视化服务于历史表达' },
        ],
        contacts: [
            { icon: 'fa-solid fa-envelope', label: '邮箱', value: '858998723@qq.com', action: 'copy', desc: '欢迎来信交流与反馈' },
            { icon: 'fa-brands fa-github', label: 'GitHub', value: 'github.com/LiChongrui/map', href: 'https://github.com/LiChongrui/map', desc: '查看项目源码与最新动态' },
        ],
    },
};