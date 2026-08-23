/**
 * 主入口 - 从 manifest.json 加载数据
 */

(function() {
    
    // ---------- 初始化地图 ----------
    MapManager.init('map');
    UIManager.init();

    // ---------- 加载数据 ----------
    async function loadData() {
        try {
            const sources = await DataScanner.scanAndLoad();
            
            if (sources.length === 0) {
                UIManager.showToast('⚠️ 未找到数据配置', 'warning');
                UIManager.updateLayerPanel();
                LayerManager.updateStats();
                
                console.log('📄 请创建 data/manifest.json 文件');
                console.log('📄 示例格式:');
                console.log(JSON.stringify({ files: ['your_file.geojson'] }, null, 2));
                return;
            }

            CONFIG.dataSources = sources;
            
            await LayerManager.loadAllLayers();
            
            const allLayers = LayerManager.getAllLayers();
            const map = MapManager.getMap();
            if (allLayers.size > 0) {
                const bounds = L.latLngBounds();
                let hasValid = false;
                for (const [, info] of allLayers) {
                    if (info.visible && map.hasLayer(info.layer) && info.layer.getBounds().isValid()) {
                        bounds.extend(info.layer.getBounds());
                        hasValid = true;
                    }
                }
                if (hasValid) {
                    MapManager.fitBounds(bounds, { padding: [50, 50] });
                }
            }
            
        } catch (error) {
            console.error('❌ 加载数据失败:', error);
            UIManager.showToast('❌ 加载数据失败，请检查控制台', 'error');
            UIManager.updateLayerPanel();
            LayerManager.updateStats();
        }
    }

    loadData();

    window.__APP = {
        map: MapManager,
        layers: LayerManager,
        ui: UIManager,
        scanner: DataScanner,
        config: CONFIG,
    };

    console.log('💡 调试: window.__APP');

})();