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
        '高德卫星': {
            url: 'https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
            options: { maxZoom: 18, attribution: '© 高德地图' }
        },
        '高德街道': {
            url: 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
            options: { maxZoom: 18, attribution: '© 高德地图' }
        }
    },

    defaultBaseLayer: '高德街道',

    // ---------- 数据源配置（由 manifest.json 加载） ----------
    dataSources: [],

    // ---------- 颜色调色板 ----------
    colorPalette: [
        '#4f6ef7', '#ef4444', '#10b981', '#8b5cf6', '#f59e0b',
        '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
        '#06b6d4', '#d946ef', '#22c55e', '#e11d48', '#0ea5e9',
    ],
};