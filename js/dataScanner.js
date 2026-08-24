/**
 * 数据加载器 - 从 manifest.json 读取数据集配置
 *
 * manifest 支持以下格式（均可混用字符串或 { file, name, color } 对象）：
 *   1. 推荐：{ "datasets": [{ "name": "数据集名", "files": [...] }, ...] }
 *   2. 旧版：{ "dataset": { "分组名": [files...] } }
 *   3. 旧版：{ "dataset": [{ "name": ..., "files": [...] }] }
 *   4. 旧版：{ "files": [...] }（全部归入“未分组”）
 *
 * 解析结果为数据集列表：[{ name, sources: [layerSourceConfig...] }]
 * 图层是否加载由用户在界面上“添加数据集”决定，此处只负责解析。
 */

const DataScanner = (function() {

    let datasets = [];

    // ---------- manifest → 数据集原始结构 ----------
    function parseManifest(manifest) {
        const list = [];
        if (Array.isArray(manifest.datasets)) {
            manifest.datasets.forEach(dataset => {
                if (!dataset || typeof dataset !== 'object') return;
                const name = String(dataset.name || '').trim() || '未命名数据集';
                list.push({ name, files: Array.isArray(dataset.files) ? dataset.files : [] });
            });
        } else if (manifest.dataset && typeof manifest.dataset === 'object' && !Array.isArray(manifest.dataset)) {
            Object.entries(manifest.dataset).forEach(([name, files]) => {
                list.push({ name, files: Array.isArray(files) ? files : [] });
            });
        } else if (Array.isArray(manifest.dataset)) {
            manifest.dataset.forEach(dataset => {
                if (!dataset || typeof dataset !== 'object') return;
                list.push({ name: String(dataset.name || '未分组'), files: Array.isArray(dataset.files) ? dataset.files : [] });
            });
        } else if (Array.isArray(manifest.files)) {
            list.push({ name: '未分组', files: manifest.files });
        }
        return list;
    }

    // ---------- 从 manifest.json 加载数据集 ----------
    async function scanAndLoad() {
        try {
            const response = await fetch('data/manifest.json');

            if (!response.ok) {
                console.error('❌ manifest.json 加载失败! 状态码:', response.status);
                console.warn('💡 请确保 data/manifest.json 文件存在');
                datasets = [];
                CONFIG.datasets = datasets;
                CONFIG.dataSources = [];
                return datasets;
            }

            const manifest = await response.json();
            const raw = parseManifest(manifest);

            if (raw.length === 0) {
                console.warn('⚠️ manifest.json 中无有效数据集');
                datasets = [];
                CONFIG.datasets = datasets;
                CONFIG.dataSources = [];
                return datasets;
            }

            const colorPalette = CONFIG.colorPalette || [];
            let colorIndex = 0;

            datasets = raw.map((dataset, datasetIndex) => {
                const sources = dataset.files
                    .map(entry => {
                        const isObject = entry && typeof entry === 'object';
                        const file = isObject ? (entry.file || entry.path || '') : String(entry || '');
                        if (!file) return null;
                        const name = (isObject && entry.name) || getDisplayName(file);
                        const color = (isObject && entry.color) || colorPalette[colorIndex++ % colorPalette.length];
                        return {
                            // id 含数据集名前缀，跨数据集同名文件不会冲突；保持旧规则以兼容已保存的样式
                            id: generateId(`${dataset.name}_${file}`),
                            name: name || file,
                            url: 'data/' + file,
                            color: color,
                            fillColor: color + '33',
                            group: dataset.name,
                            visible: true,
                            order: colorIndex,
                            filename: file,
                        };
                    })
                    .filter(Boolean);
                return { name: dataset.name, order: datasetIndex, sources };
            }).filter(dataset => dataset.sources.length > 0);

            CONFIG.datasets = datasets;
            // 兼容旧引用：全部数据源平铺列表
            CONFIG.dataSources = datasets.reduce((all, dataset) => all.concat(dataset.sources), []);

            console.log(`✅ 已解析 ${datasets.length} 个数据集 / ${CONFIG.dataSources.length} 个图层`);
            return datasets;

        } catch (error) {
            console.error('❌ 读取 manifest.json 失败:', error.message);
            datasets = [];
            CONFIG.datasets = datasets;
            CONFIG.dataSources = [];
            return datasets;
        }
    }

    // ---------- 生成显示名称 ----------
    function getDisplayName(filename) {
        let name = filename.replace(/\.(geojson|json)$/i, '');
        name = name.replace(/[_-]/g, ' ');
        name = name.replace(/\b\w/g, l => l.toUpperCase());
        if (name.length > 25) {
            name = name.substring(0, 23) + '…';
        }
        return name || filename;
    }

    // ---------- 生成唯一ID ----------
    function generateId(filename) {
        return filename
            .replace(/\.(geojson|json)$/i, '')
            .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')
            .toLowerCase();
    }

    // ---------- 获取数据集 ----------
    function getDatasets() {
        return datasets;
    }

    function getDataset(name) {
        return datasets.find(dataset => dataset.name === name) || null;
    }

    // ---------- 公开 API ----------
    return {
        scanAndLoad,
        getDatasets,
        getDataset,
        generateId,
        getDisplayName,
    };

})();
