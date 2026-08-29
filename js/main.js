/**
 * 主入口 - 解析 manifest 数据集，初次打开默认添加第一组数据集
 */

(function() {

    // ---------- 初始化地图 ----------
    MapManager.init('map');
    // 测量工具（测距 / 测面积，地图右侧垂直工具栏）
    MeasureTools.init(MapManager.getMap(), document.getElementById('mapTools'));
    // 点击地图空白处（未点中要素）移除图层高亮
    MapManager.getMap().on('click', () => LayerManager.clearLayerHighlight());
    UIManager.init();

    // 缩放到指定数据集内全部可见图层的范围
    function fitToDataset(name) {
        const bounds = L.latLngBounds();
        let hasValid = false;
        LayerManager.getLayersByGroup(name).forEach(info => {
            if (info.visible && info.layer.getBounds().isValid()) {
                bounds.extend(info.layer.getBounds());
                hasValid = true;
            }
        });
        if (hasValid) MapManager.fitBounds(bounds);
    }

    // ---------- 初始化数据 ----------
    async function init() {
        try {
            const datasets = await DataScanner.scanAndLoad();

            // R138：默认加载「隋唐洛阳-城」数据集（清单中存在且尚未加载时）
            const DEFAULT_DATASET = '隋唐洛阳-城';
            const defaultExists = DataScanner.getDatasets().some(d => d.name === DEFAULT_DATASET);
            const defaultLoaded = LayerManager.getLoadedGroupNames().includes(DEFAULT_DATASET);

            UIManager.updateLayerPanel();
            LayerManager.updateStats();

            if (datasets.length === 0) {
                UIManager.showToast('未找到可用数据集', 'warning');
                console.warn('[数据] 未配置任何数据集');
            } else if (defaultExists && !defaultLoaded) {
                // 默认加载并缩放到该数据集范围（addDatasets 内部已 fitBounds）
                await UIManager.addDatasets([DEFAULT_DATASET]);
                // 刷新两个视图的列表与统计（数据集行标记「已添加」、图层列表同步）
                UIManager.updateLayerPanel();
            }
        } catch (error) {
            console.error('❌ 初始化失败:', error);
            UIManager.showToast('❌ 初始化失败，请检查控制台', 'error');
            UIManager.updateLayerPanel();
            LayerManager.updateStats();
        }
    }

    init();

})();
