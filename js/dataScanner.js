/**
 * 数据加载器 - 从 manifest.json 读取配置
 */

const DataScanner = (function() {
    
    // ---------- 从 manifest.json 加载数据源 ----------
    async function loadFromManifest() {
        console.log('🔍 当前页面地址:', window.location.href);
        console.log('🔍 尝试加载: data/manifest.json');
        
        try {
            const response = await fetch('data/manifest.json');
            console.log('📡 响应状态:', response.status, response.statusText);
            
            if (!response.ok) {
                console.error('❌ 加载失败! 状态码:', response.status);
                console.warn('💡 请确保 data/manifest.json 文件存在');
                return [];
            }
            
            const manifest = await response.json();
            console.log('✅ manifest.json 加载成功!');
            console.log('📄 内容:', manifest);
            
            const entries = [];
            if (manifest.dataset && typeof manifest.dataset === 'object' && !Array.isArray(manifest.dataset)) {
                Object.entries(manifest.dataset).forEach(([group, files]) => {
                    if (Array.isArray(files)) files.forEach(file => entries.push({ file, group }));
                });
            } else if (Array.isArray(manifest.dataset)) {
                manifest.dataset.forEach(dataset => {
                    if (dataset && Array.isArray(dataset.files)) {
                        dataset.files.forEach(file => entries.push({ file, group: dataset.name || '未分组' }));
                    }
                });
            } else if (Array.isArray(manifest.files)) {
                manifest.files.forEach(file => entries.push({ file, group: '未分组' }));
            }

            if (entries.length === 0) {
                console.warn('⚠️ manifest.json 中 files 为空');
                return [];
            }

            console.log(`📂 发现 ${entries.length} 个文件:`, entries);

            const colorPalette = CONFIG.colorPalette || [];
            const sources = entries.map((datasetEntry, index) => {
                const entry = datasetEntry.file;
                let name, file, color;
                if (typeof entry === 'string') {
                    file = entry;
                    name = getDisplayName(entry);
                    color = colorPalette[index % colorPalette.length];
                } else if (entry && typeof entry === 'object') {
                    file = entry.file || entry.path || '';
                    name = entry.name || getDisplayName(file);
                    color = entry.color || colorPalette[index % colorPalette.length];
                }
                
                return {
                    id: generateId(`${datasetEntry.group}_${file}`),
                    name: name || file,
                    url: 'data/' + file,
                    color: color,
                    fillColor: color + '33',
                    group: datasetEntry.group || (entry && entry.group) || '未分组',
                    visible: true,
                    order: index,
                    filename: file,
                };
            });

            console.log(`✅ 生成 ${sources.length} 个数据源配置`);
            return sources;

        } catch (error) {
            console.error('❌ 读取 manifest.json 失败:', error.message);
            return [];
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

    // ---------- 加载并应用配置 ----------
    async function scanAndLoad() {
        const sources = await loadFromManifest();
        
        if (sources.length === 0) {
            console.warn('💡 请创建 data/manifest.json 文件');
            console.warn('📄 示例: { "files": ["points.geojson"] }');
        }
        
        CONFIG.dataSources = sources;
        return sources;
    }

    // ---------- 获取数据源 ----------
    function getDataSources() {
        return CONFIG.dataSources || [];
    }

    // ---------- 公开 API ----------
    return {
        scanAndLoad,
        getDataSources,
        generateId,
        getDisplayName,
    };

})();