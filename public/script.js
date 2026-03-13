document.addEventListener("DOMContentLoaded", () => {
    const modelSelect = document.getElementById("model-select");
    const chatContainer = document.getElementById("chat-container");
    const userInput = document.getElementById("user-input");
    const sendBtn = document.getElementById("send-btn");
    const chatForm = document.getElementById("chat-form");
    const emptyState = document.getElementById("empty-state");
    const newChatBtn = document.getElementById("new-chat-btn");

    // Files Tab chat elements
    const chatContainerFiles = document.getElementById("chat-container-files");
    const emptyStateFiles = document.getElementById("empty-state-files");

    let chatHistory = [];
    let filesChatHistory = [];
    let currentChatId = null;
    let currentFilesChatId = null;
    let isGenerating = false;
    let mainAttachedFiles = []; // For the 'Chat' tab
    let filesAttachedFiles = []; // For the 'Files' tab

    // Configure marked properties for highlight.js
    const renderer = new marked.Renderer();

    marked.setOptions({
        renderer: renderer,
        highlight: function (code, lang) {
            const language = hljs.getLanguage(lang) ? lang : 'plaintext';
            return hljs.highlight(code, { language }).value;
        },
        breaks: false // Breaks can destroy math alignments
    });

    if (window.markedKatex) {
        marked.use(window.markedKatex({ throwOnError: false }));
    }

    // Auto-resize textarea
    function updateSendButtonState(inputEl, btnEl, isFilesTab) {
        const attachments = isFilesTab ? filesAttachedFiles : mainAttachedFiles;
        const hasImages = attachments.some(f => isImageFile(f.name));
        const hasText = inputEl.value.trim() !== "";
        btnEl.disabled = (!hasText && !hasImages) || isGenerating;
    }

    userInput.addEventListener("input", function () {
        this.style.height = "auto";
        this.style.height = (this.scrollHeight) + "px";
        if (this.scrollHeight > 200) {
            this.style.overflowY = "auto";
        } else {
            this.style.overflowY = "hidden";
        }
        updateSendButtonState(this, sendBtn, false);
    });

    userInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!sendBtn.disabled) {
                chatForm.dispatchEvent(new Event("submit"));
            }
        }
    });

    function handlePasteImages(e, isFilesTab) {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) {
                    const ext = file.type.split('/')[1] || 'png';
                    const name = `pasted-image-${Date.now()}.${ext}`;
                    const renamedFile = new File([file], name, { type: file.type });
                    handleFileUpload([renamedFile], isFilesTab);
                }
                return;
            }
        }
    }

    userInput.addEventListener("paste", (e) => handlePasteImages(e, false));

    const attachBtnMain = document.getElementById("attach-btn-main");
    const fileInputMain = document.getElementById("file-input-main");
    attachBtnMain.addEventListener("click", () => fileInputMain.click());
    fileInputMain.addEventListener("change", () => {
        if (fileInputMain.files.length > 0) {
            handleFileUpload(fileInputMain.files, false);
            fileInputMain.value = "";
        }
    });

    const VISION_MODEL_PATTERNS = ['llava', 'llama3.2-vision', 'moondream', 'bakllava', 'minicpm-v'];
    const visionModelSelect = document.getElementById("vision-model-select");
    const visionModelContainer = document.getElementById("vision-model-container");

    async function loadModels() {
        try {
            const response = await fetch('/api/tags');
            const data = await response.json();

            modelSelect.innerHTML = '';
            visionModelSelect.innerHTML = '<option value="">None (disabled)</option>';

            if (data.models && data.models.length > 0) {
                const visionModels = [];
                const thinkingModels = [];

                data.models.forEach(model => {
                    const isVision = VISION_MODEL_PATTERNS.some(p => model.name.toLowerCase().includes(p));
                    if (isVision) {
                        visionModels.push(model.name);
                    } else {
                        thinkingModels.push(model.name);
                    }
                });

                if (thinkingModels.length > 0) {
                    thinkingModels.forEach(name => {
                        const option = document.createElement("option");
                        option.value = name;
                        option.textContent = name;
                        modelSelect.appendChild(option);
                    });
                } else {
                    modelSelect.innerHTML = '<option value="">No thinking models found</option>';
                    const hint = document.createElement('p');
                    hint.className = 'vision-hint';
                    hint.textContent = 'You only have vision models installed. Install a thinking model (e.g. llama3.2, qwen2.5, gemma2) from Settings.';
                    hint.style.color = '#f87171';
                    const container = modelSelect.parentElement;
                    if (!container.querySelector('.vision-hint:last-child')) container.appendChild(hint);
                }

                const visionHint = document.getElementById("vision-model-hint");
                if (visionModels.length > 0) {
                    visionModels.forEach(name => {
                        const opt = document.createElement("option");
                        opt.value = name;
                        opt.textContent = name;
                        visionModelSelect.appendChild(opt);
                    });
                    visionModelSelect.value = visionModels[0];
                    if (visionHint) visionHint.style.display = 'none';
                } else {
                    if (visionHint) visionHint.style.display = 'block';
                }
            } else {
                modelSelect.innerHTML = '<option value="">No models found</option>';
            }
        } catch (error) {
            console.error("Error fetching models:", error);
            modelSelect.innerHTML = '<option value="">Failed to connect to Ollama</option>';
        }
    }

    const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];

    function isImageFile(name) {
        return IMAGE_EXTENSIONS.includes(name.split('.').pop().toLowerCase());
    }

    function getFileIcon(name) {
        const ext = name.split('.').pop().toLowerCase();
        if (ext === 'pdf') return '📕';
        if (['xlsx', 'xls', 'csv'].includes(ext)) return '📊';
        if (IMAGE_EXTENSIONS.includes(ext)) return '🖼️';
        return '📄';
    }

    function getImageUrl(filePath) {
        return `/api/files/serve?path=${encodeURIComponent(filePath)}`;
    }

    let recentFiles = [];
    const MAX_RECENT_FILES = 10;

    function trackRecentFile(name, filePath) {
        recentFiles = recentFiles.filter(f => f.path !== filePath);
        recentFiles.unshift({ name, path: filePath });
        if (recentFiles.length > MAX_RECENT_FILES) recentFiles.pop();
        renderRecentFiles();
    }

    function renderRecentFiles() {
        const list = document.getElementById('recent-files-list');
        if (!list) return;
        list.innerHTML = '';
        if (recentFiles.length === 0) {
            list.innerHTML = '<li class="recent-file-empty">No recent files</li>';
            return;
        }
        recentFiles.forEach(file => {
            const li = document.createElement('li');
            li.className = 'recent-file-item';
            li.innerHTML = `<span class="recent-file-icon">${getFileIcon(file.name)}</span><span>${file.name}</span>`;
            li.title = file.path;
            li.draggable = true;
            li.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('application/myai-file', JSON.stringify({ name: file.name, path: file.path }));
            });
            li.addEventListener('click', async () => {
                try {
                    const res = await fetch(`/api/files/read?path=${encodeURIComponent(file.path)}`);
                    const data = await res.json();
                    if (data.content) {
                        const isFilesActive = document.getElementById('files-view').classList.contains('active');
                        attachFile(file.name, file.path, data.content, isFilesActive);
                    }
                } catch (e) { console.error("Error attaching recent file:", e); }
            });
            list.appendChild(li);
        });
    }

    function resetChat() {
        chatHistory = [];
        currentChatId = null;
        chatContainer.innerHTML = '';
        chatContainer.appendChild(emptyState);
        emptyState.style.display = "flex";
        isGenerating = false;
        userInput.value = "";
        userInput.style.height = "auto";
        sendBtn.disabled = true;
    }

    function resetFilesChat() {
        filesChatHistory = [];
        currentFilesChatId = null;
        chatContainerFiles.innerHTML = '';
        chatContainerFiles.appendChild(emptyStateFiles);
        emptyStateFiles.style.display = "flex";
        isGenerating = false;
        const filesInput = document.getElementById("user-input-files");
        const filesBtn = document.getElementById("send-btn-files");
        if (filesInput) { filesInput.value = ""; filesInput.style.height = "auto"; }
        if (filesBtn) filesBtn.disabled = true;
        filesAttachedFiles = [];
        renderAttachedFiles(true);
    }

    newChatBtn.addEventListener("click", () => {
        const isFilesActive = document.getElementById('files-view').classList.contains('active');
        if (isFilesActive) {
            resetFilesChat();
        } else {
            resetChat();
        }
    });

    function addMessageElement(role, initialContent = "", targetContainer, targetEmptyState, attachedFiles = []) {
        if (targetEmptyState && targetEmptyState.style.display !== "none") {
            targetEmptyState.style.display = "none";
        }

        const msgDiv = document.createElement("div");
        msgDiv.className = `message ${role}`;

        const avatarDiv = document.createElement("div");
        avatarDiv.className = "avatar";
        avatarDiv.textContent = role === "user" ? "U" : "🤖";

        let renderText = initialContent;
        renderText = renderText.replace(/\\\[/g, () => '$$').replace(/\\\]/g, () => '$$');
        renderText = renderText.replace(/\\\(/g, () => '$').replace(/\\\)/g, () => '$');

        const contentDiv = document.createElement("div");
        contentDiv.className = "message-content";
        contentDiv.innerHTML = marked.parse(renderText);

        if (role === "assistant") {
            const labelDiv = document.createElement("div");
            labelDiv.className = "message-sender-label";
            labelDiv.textContent = "MyAI";
            msgDiv.appendChild(labelDiv);
        }

        if (role === "user" && attachedFiles.length > 0) {
            const imageFiles = attachedFiles.filter(f => f.thumbnailUrl || isImageFile(f.name));
            const otherFiles = attachedFiles.filter(f => !f.thumbnailUrl && !isImageFile(f.name));

            if (imageFiles.length > 0) {
                const imageGrid = document.createElement("div");
                imageGrid.className = "message-image-grid";
                imageFiles.forEach(file => {
                    const thumb = document.createElement("div");
                    thumb.className = "message-image-thumb";
                    const url = file.thumbnailUrl || getImageUrl(file.path);
                    const img = document.createElement("img");
                    img.src = url;
                    img.alt = file.name;
                    img.addEventListener('error', () => {
                        thumb.classList.add('image-load-failed');
                        thumb.innerHTML = `<span class="image-fail-icon">🖼️</span><span class="message-image-name" style="opacity:1;">${file.name}</span>`;
                    });
                    img.addEventListener('click', () => {
                        window.open(url, '_blank');
                    });
                    const nameSpan = document.createElement("span");
                    nameSpan.className = "message-image-name";
                    nameSpan.textContent = file.name;
                    thumb.appendChild(img);
                    thumb.appendChild(nameSpan);
                    imageGrid.appendChild(thumb);
                });
                msgDiv.appendChild(imageGrid);
            }

            if (otherFiles.length > 0) {
                const filesBar = document.createElement("div");
                filesBar.className = "message-attached-files";
                otherFiles.forEach(file => {
                    const chip = document.createElement("div");
                    chip.className = "message-file-chip";
                    chip.innerHTML = `<span class="message-file-chip-icon">${getFileIcon(file.name)}</span><span>${file.name}</span>`;
                    filesBar.appendChild(chip);
                });
                msgDiv.appendChild(filesBar);
            }
        }

        msgDiv.appendChild(avatarDiv);
        msgDiv.appendChild(contentDiv);
        targetContainer.appendChild(msgDiv);

        targetContainer.scrollTop = targetContainer.scrollHeight;

        return contentDiv;
    }

    // Shared Chat Submission Logic
    async function handleChatSubmit(inputElement, buttonElement, targetHistory, targetContainer, targetEmptyState, isFilesTab = false) {
        const currentAttachmentsCheck = isFilesTab ? filesAttachedFiles : mainAttachedFiles;
        const hasImageAttachments = currentAttachmentsCheck.some(f => isImageFile(f.name));

        if (isGenerating) return;
        if (inputElement.value.trim() === "" && !hasImageAttachments) return;

        let messageText = inputElement.value.trim();
        const selectedModel = modelSelect.value;

        if (messageText === "" && hasImageAttachments) {
            messageText = "Solve this step by step and explain your reasoning.";
        }

        const displayMessageText = messageText;

        if (!selectedModel) {
            alert("Please ensure Ollama is running and a model is loaded.");
            return;
        }

        inputElement.value = "";
        inputElement.style.height = "auto";
        buttonElement.disabled = true;
        isGenerating = true;

        let searchContext = "";

        // Inject attached files context based on the current tab
        const currentAttachments = isFilesTab ? filesAttachedFiles : mainAttachedFiles;
        if (currentAttachments.length > 0) {
            searchContext += "\n\n--- Shared Context from Attached Files ---";
            currentAttachments.forEach(file => {
                searchContext += `\n\n[File: ${file.name}]\n${file.content}\n[End of ${file.name}]`;
            });
            searchContext += "\n--- End of Shared Context ---";
        }

        if (isFilesTab) {
            // Local Search Logic for Files Tab
            try {
                const filesRes = await fetch('/api/files');
                const files = await filesRes.json();

                const keywords = messageText.toLowerCase().split(' ').filter(w => w.length > 3);
                for (const file of files) {
                    if (file.isDirectory) continue;
                    // For radical simplicity, inject ALL files content if we are in files tab
                    // Wait, that might be too long, let's keep keyword match.
                    const hasMatch = keywords.some(k => file.name.toLowerCase().includes(k)) || keywords.length === 0;
                    if (hasMatch) {
                        const contentRes = await fetch(`/api/files/read?path=${encodeURIComponent(file.path)}`);
                        const contentData = await contentRes.json();
                        if (contentData.content) {
                            searchContext += `\n\n--- Content from file: ${file.name} ---\n${contentData.content}\n--- End of file ---`;
                        }
                    }
                }
            } catch (e) { console.error("Search error:", e); }
        }
        try {
            const filesRes = await fetch('/api/files');
            const files = await filesRes.json();

            const keywords = messageText.toLowerCase().split(' ').filter(w => w.length > 3);
            for (const file of files) {
                if (file.isDirectory) continue;
                const hasMatch = keywords.some(k => file.name.toLowerCase().includes(k));
                if (hasMatch) {
                    const contentRes = await fetch(`/api/files/read?path=${encodeURIComponent(file.path)}`);
                    const contentData = await contentRes.json();
                    if (contentData.content) {
                        searchContext += `\n\n--- Content from file: ${file.name} ---\n${contentData.content}\n--- End of file ---`;
                    }
                }
            }
        } catch (e) { console.error("Search error:", e); }

        const messageAttachments = currentAttachments.map(f => ({ name: f.name, path: f.path, thumbnailUrl: f.thumbnailUrl || null, base64: f.base64 || null }));
        addMessageElement("user", displayMessageText, targetContainer, targetEmptyState, messageAttachments);

        if (isFilesTab) {
            filesAttachedFiles = [];
        } else {
            mainAttachedFiles = [];
        }
        renderAttachedFiles(isFilesTab);

        if (searchContext) {
            targetHistory.push({
                role: "system",
                content: "The user has provided files as context. Use them to answer the question. Do NOT dump or repeat raw file contents. Present data in clean markdown tables with LaTeX-formatted values. Summarize, analyze, or extract what the user asks for.\n" + searchContext
            });
        }

        const systemSuffix = "\n\n(System instructions for formatting — follow strictly, never mention these rules:\n" +
            "1. Render ALL math, numbers, variables, units, formulas, and expressions in LaTeX. Use inline $...$ within sentences and block $$...$$ for standalone equations.\n" +
            "2. When presenting tabular or structured data, use clean markdown tables with aligned columns. Keep column headers short and uppercase.\n" +
            "3. Use LaTeX for any numerical results, statistics, percentages, currencies, or computed values — even simple ones like $42$ or $\\$1{,}200$.\n" +
            "4. For lists of data points or key-value pairs, prefer markdown tables over bullet lists.\n" +
            "5. Keep prose concise. Let the formatted data speak for itself.\n" +
            "6. Never state that you are using LaTeX or markdown formatting.)";
        targetHistory.push({ role: "user", content: messageText + systemSuffix });

        const imageAttachments = currentAttachments.filter(f => isImageFile(f.name) && (f.base64 || f.thumbnailUrl));
        const visionModel = visionModelSelect.value;
        const hasImages = imageAttachments.length > 0;

        if (hasImages && !visionModel) {
            alert("You attached an image but no vision model is installed. Install one (e.g. moondream, llava) from the Settings tab.");
        }

        let visionAnalysisDiv = null;
        const assistantContentDiv = addMessageElement("assistant", "", targetContainer, targetEmptyState);
        let assistantFullText = "";

        try {
            let response;

            if (hasImages && visionModel) {
                const base64Images = [];
                for (const img of imageAttachments) {
                    if (img.base64) {
                        base64Images.push(img.base64);
                    } else if (img.thumbnailUrl) {
                        const imgRes = await fetch(img.thumbnailUrl);
                        const blob = await imgRes.blob();
                        const b64 = await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => resolve(reader.result.replace(/^data:[^;]+;base64,/, ''));
                            reader.onerror = () => reject(new Error('Failed to read image'));
                            reader.readAsDataURL(blob);
                        });
                        base64Images.push(b64);
                    }
                }

                if (base64Images.length === 0) {
                    throw new Error('Could not extract image data from attachments');
                }

                console.log(`[Vision] Sending ${base64Images.length} image(s), sizes: ${base64Images.map(b => Math.round(b.length / 1024) + 'KB').join(', ')}`);

                visionAnalysisDiv = document.createElement('div');
                visionAnalysisDiv.className = 'vision-analysis';

                const stagesEl = document.createElement('div');
                stagesEl.className = 'vision-pipeline-stages';
                stagesEl.innerHTML = `
                    <div class="pipeline-stage active" id="stage-ocr"><span class="vision-analysis-spinner"></span> OCR + Vision scan running...</div>
                    <div class="pipeline-stage" id="stage-router">Classifying content...</div>
                    <div class="pipeline-stage" id="stage-thinking">Generating response...</div>
                `;
                visionAnalysisDiv.appendChild(stagesEl);

                const detailsEl = document.createElement('details');
                detailsEl.className = 'vision-analysis-box';
                detailsEl.innerHTML = '<summary>Extracted Content</summary><div class="vision-analysis-content"></div>';
                detailsEl.style.display = 'none';
                visionAnalysisDiv.appendChild(detailsEl);

                assistantContentDiv.parentElement.insertBefore(visionAnalysisDiv, assistantContentDiv);
                targetContainer.scrollTop = targetContainer.scrollHeight;

                response = await fetch('/api/chat/vision', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        visionModel: visionModel,
                        thinkingModel: selectedModel,
                        messages: [...targetHistory],
                        images: base64Images
                    })
                });
            } else {
                response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: selectedModel,
                        messages: [...targetHistory],
                        stream: true
                    })
                });
            }

            if (!response.ok) throw new Error("Failed to connect to Ollama API");

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let visionDone = !hasImages;
            let streamBuffer = '';
            let streamFinished = false;

            while (true) {
                const { done, value } = await reader.read();
                if (done || streamFinished) break;

                streamBuffer += decoder.decode(value, { stream: true });
                const lines = streamBuffer.split('\n');
                streamBuffer = lines.pop();

                for (let line of lines) {
                    if (streamFinished) break;
                    if (line.trim() !== '') {
                        try {
                            const data = JSON.parse(line);

                            if (data.vision_analysis !== undefined && visionAnalysisDiv) {
                                const contentEl = visionAnalysisDiv.querySelector('.vision-analysis-content');
                                contentEl.textContent = data.vision_analysis || '(No content extracted)';

                                const detailsBox = visionAnalysisDiv.querySelector('.vision-analysis-box');
                                detailsBox.style.display = '';

                                const stageOcr = visionAnalysisDiv.querySelector('#stage-ocr');
                                const stageRouter = visionAnalysisDiv.querySelector('#stage-router');
                                const stageThinking = visionAnalysisDiv.querySelector('#stage-thinking');

                                if (stageOcr) { stageOcr.classList.remove('active'); stageOcr.classList.add('done'); stageOcr.innerHTML = '&#10003; Content extracted'; }

                                const classification = data.classification || '';
                                if (classification) {
                                    if (stageRouter) { stageRouter.classList.remove('active'); stageRouter.classList.add('done'); stageRouter.innerHTML = classification === 'schoolwork' ? '&#10003; Schoolwork detected — tutor mode' : '&#10003; General image — standard mode'; }
                                    if (stageThinking) { stageThinking.classList.add('active'); stageThinking.innerHTML = '<span class="vision-analysis-spinner"></span> ' + (classification === 'schoolwork' ? 'Solving step by step...' : 'Generating response...'); }
                                } else {
                                    if (stageRouter) { stageRouter.classList.add('active'); stageRouter.innerHTML = '<span class="vision-analysis-spinner"></span> Classifying content...'; }
                                }

                                visionDone = true;
                                targetContainer.scrollTop = targetContainer.scrollHeight;
                                continue;
                            }

                            if (data.error) {
                                assistantFullText += `\n\n**Vision Error:** ${data.error}`;
                                assistantContentDiv.innerHTML = marked.parse(assistantFullText);
                                continue;
                            }

                            if (data.done) {
                                if (visionAnalysisDiv) {
                                    const stageThinking = visionAnalysisDiv.querySelector('#stage-thinking');
                                    if (stageThinking) { stageThinking.classList.remove('active'); stageThinking.classList.add('done'); stageThinking.innerHTML = '&#10003; Complete'; }
                                }
                                streamFinished = true;
                                break;
                            }

                            if (data.message && data.message.content) {
                                assistantFullText += data.message.content;
                                let renderText = assistantFullText;
                                renderText = renderText.replace(/\\\[/g, () => '$$').replace(/\\\]/g, () => '$$');
                                renderText = renderText.replace(/\\\(/g, () => '$').replace(/\\\)/g, () => '$');
                                renderText = renderText.replace(/([^\n=]{1,50}?)\s*=\s*\$\$([\s\S]*?)\$\$/g, (match, lhs, expr) => {
                                    return `$$ ${lhs.trim()} = ${expr.trim()} $$`;
                                });
                                assistantContentDiv.innerHTML = marked.parse(renderText);
                                const isScrolledToBottom = targetContainer.scrollHeight - targetContainer.clientHeight <= targetContainer.scrollTop + 50;
                                if (isScrolledToBottom) targetContainer.scrollTop = targetContainer.scrollHeight;
                            }
                        } catch (e) {
                            console.warn('Failed to parse stream chunk:', line.substring(0, 200), e);
                        }
                    }
                }
            }
            targetHistory.push({ role: "assistant", content: assistantFullText });
            setupAskButtons(assistantContentDiv, targetContainer, targetHistory, targetEmptyState, isFilesTab);

            // Persist Chat History (We'll use currentChatId or currentFilesChatId)
            const chatIdToUse = isFilesTab ? currentFilesChatId : currentChatId;
            fetch('/api/chats', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: chatIdToUse,
                    history: targetHistory,
                    title: isFilesTab ? `Files Chat: ${messageText.substring(0, 15)}...` : messageText.substring(0, 30) + (messageText.length > 30 ? '...' : '')
                })
            }).then(res => res.json()).then(data => {
                if (data.success && data.id) {
                    if (isFilesTab) currentFilesChatId = data.id;
                    else currentChatId = data.id;
                }
                loadChatHistory();
            });
        } catch (error) {
            console.error("Error generating response:", error);
            assistantContentDiv.innerHTML = `<span style="color: red;">Error: Could not obtain response from local Ollama endpoint.</span>`;
        }

        isGenerating = false;
        buttonElement.disabled = false;
    }

    const chatHistoryList = document.getElementById("chat-history-list");
    const filesChatHistoryList = document.getElementById("files-chat-history-list");

    async function loadChatHistory() {
        try {
            const res = await fetch('/api/chats');
            const chats = await res.json();
            chatHistoryList.innerHTML = '';
            if (filesChatHistoryList) filesChatHistoryList.innerHTML = '';

            chats.reverse().forEach(chat => {
                const isFilesChat = chat.title && chat.title.startsWith('Files Chat:');
                const li = document.createElement('li');
                li.className = 'chat-history-item';

                const chatIcon = isFilesChat
                    ? '<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" height="1em" width="1em"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
                    : '<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" height="1em" width="1em"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>';

                const displayTitle = isFilesChat ? chat.title.replace('Files Chat: ', '') : chat.title;
                li.innerHTML = `${chatIcon}<span>${displayTitle}</span>`;

                li.addEventListener('click', async () => {
                    try {
                        const fullRes = await fetch(`/api/chats/${chat.id}`);
                        const fullChat = await fullRes.json();
                        if (isFilesChat) {
                            filesChatHistory = fullChat.history || [];
                            currentFilesChatId = fullChat.id;
                            renderFilesChatHistory();
                            const filesTab = document.querySelector('.tab-btn[data-target="files-view"]');
                            if (filesTab) filesTab.click();
                        } else {
                            chatHistory = fullChat.history || [];
                            currentChatId = fullChat.id;
                            renderChatHistory();
                            const chatTab = document.querySelector('.tab-btn[data-target="chat-view"]');
                            if (chatTab && !document.getElementById('chat-view').classList.contains('active')) {
                                chatTab.click();
                            }
                        }
                    } catch (err) {
                        console.error("Error loading chat:", err);
                    }
                });

                if (isFilesChat && filesChatHistoryList) {
                    filesChatHistoryList.appendChild(li);
                } else {
                    chatHistoryList.appendChild(li);
                }
            });
        } catch (e) { console.error("History error:", e); }
    }

    function renderChatHistory() {
        chatContainer.innerHTML = '';
        if (chatHistory.length > 0) emptyState.style.display = 'none';
        else emptyState.style.display = 'flex';

        chatHistory.forEach(msg => {
            if (msg.role === 'system') return;
            let displayContent = msg.content;
            if (msg.role === 'user') {
                displayContent = displayContent.replace(/\n\n\(System: Always output math expressions.*?\)$/s, '');
            }
            addMessageElement(msg.role, displayContent, chatContainer, emptyState);
        });
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function renderFilesChatHistory() {
        chatContainerFiles.innerHTML = '';
        if (filesChatHistory.length > 0) emptyStateFiles.style.display = 'none';
        else {
            chatContainerFiles.appendChild(emptyStateFiles);
            emptyStateFiles.style.display = 'flex';
        }

        filesChatHistory.forEach(msg => {
            if (msg.role === 'system') return;
            let displayContent = msg.content;
            if (msg.role === 'user') {
                displayContent = displayContent.replace(/\n\n\(System: Always output math expressions.*?\)$/s, '');
            }
            addMessageElement(msg.role, displayContent, chatContainerFiles, emptyStateFiles);
        });
        chatContainerFiles.scrollTop = chatContainerFiles.scrollHeight;
    }

    // Helper to setup ask buttons (refactored out)
    function setupAskButtons(assistantContentDiv, targetContainer, targetHistory, targetEmptyState, isFilesTab) {
        setTimeout(() => {
            const childBlocks = assistantContentDiv.querySelectorAll(':scope > p, :scope > pre, :scope > ul, :scope > ol, :scope > blockquote, :scope > .katex-display');
            childBlocks.forEach(block => {
                if (block.querySelector('.context-ask-btn')) return;
                const askBtn = document.createElement('button');
                askBtn.className = 'context-ask-btn';
                askBtn.textContent = 'Ask';
                block.style.position = 'relative';
                block.appendChild(askBtn);
                askBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (block.nextElementSibling && block.nextElementSibling.classList.contains('context-input-container')) {
                        block.nextElementSibling.querySelector('input').focus();
                        return;
                    }
                    const inputContainer = document.createElement('form');
                    inputContainer.className = 'context-input-container';
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.placeholder = 'Ask about this section...';
                    const submitBtn = document.createElement('button');
                    submitBtn.type = 'submit';
                    submitBtn.innerHTML = `<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
                    inputContainer.appendChild(input);
                    inputContainer.appendChild(submitBtn);
                    block.insertAdjacentElement('afterend', inputContainer);
                    input.focus();
                    inputContainer.addEventListener('submit', (e) => {
                        e.preventDefault();
                        const val = input.value.trim();
                        if (!val || isGenerating) return;
                        const clone = block.cloneNode(true);
                        if (clone.querySelector('.context-ask-btn')) clone.querySelector('.context-ask-btn').remove();
                        const katexElements = clone.querySelectorAll('.katex');
                        katexElements.forEach(el => {
                            const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
                            if (annotation) {
                                const isBlock = el.parentElement && el.parentElement.classList.contains('katex-display');
                                const rawLatex = isBlock ? `$$ ${annotation.textContent} $$` : `$${annotation.textContent}$`;
                                const textNode = document.createTextNode(rawLatex);
                                if (isBlock && el.parentElement) el.parentElement.replaceWith(textNode);
                                else el.replaceWith(textNode);
                            }
                        });
                        const blockContextText = clone.textContent.trim();
                        const quotedContext = blockContextText.split('\n').map(line => `> ${line}`).join('\n');
                        let combinedMessage = `**Regarding context:**\n${quotedContext}\n\n${val}`;
                        inputContainer.remove();

                        // Use the appropriate input and button based on the tab
                        const targetInput = isFilesTab ? document.getElementById("user-input-files") : userInput;
                        const targetBtn = isFilesTab ? document.getElementById("send-btn-files") : sendBtn;

                        targetInput.value = combinedMessage;
                        handleChatSubmit(targetInput, targetBtn, targetHistory, targetContainer, targetEmptyState, isFilesTab);
                    });
                });
            });
        }, 200);
    }

    // Main Chat Form
    chatForm.addEventListener("submit", (e) => {
        e.preventDefault();
        handleChatSubmit(userInput, sendBtn, chatHistory, chatContainer, emptyState, false);
    });

    // Files Chat Form
    const filesChatForm = document.querySelector(".chat-form-files");
    const filesUserInput = document.getElementById("user-input-files");
    const filesSendBtn = document.getElementById("send-btn-files");

    if (filesChatForm) {
        filesChatForm.addEventListener("submit", (e) => {
            e.preventDefault();
            handleChatSubmit(filesUserInput, filesSendBtn, filesChatHistory, chatContainerFiles, emptyStateFiles, true);
        });

        filesUserInput.addEventListener("input", function () {
            this.style.height = "auto";
            this.style.height = (this.scrollHeight) + "px";
            updateSendButtonState(this, filesSendBtn, true);
        });

        filesUserInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!filesSendBtn.disabled) filesChatForm.dispatchEvent(new Event("submit"));
            }
        });

        filesUserInput.addEventListener("paste", (e) => handlePasteImages(e, true));

        const attachBtnFiles = document.getElementById("attach-btn-files");
        const fileInputFiles = document.getElementById("file-input-files");
        attachBtnFiles.addEventListener("click", () => fileInputFiles.click());
        fileInputFiles.addEventListener("change", () => {
            if (fileInputFiles.files.length > 0) {
                handleFileUpload(fileInputFiles.files, true);
                fileInputFiles.value = "";
            }
        });
    }

    // Files Explorer Logic
    const filesList = document.getElementById("files-list");
    const refreshFilesBtn = document.getElementById("refresh-files-btn");
    refreshFilesBtn.addEventListener('click', () => loadFiles());

    async function loadFiles() {
        try {
            const response = await fetch('/api/files');
            const files = await response.json();

            filesList.innerHTML = '';
            if (!files || files.length === 0) {
                filesList.innerHTML = '<div class="view-placeholder">No files found.</div>';
                return;
            }

            renderFileTree(files, filesList);
        } catch (error) {
            console.error("Error loading files:", error);
            filesList.innerHTML = '<div class="view-placeholder">Failed to load files.</div>';
        }
    }

    function renderFileTree(files, container) {
        // Sort: Folders first, then alphabetically
        files.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        });

        files.forEach(file => {
            const item = document.createElement('div');
            item.className = 'file-item';
            if (!file.isDirectory) {
                item.draggable = true;
                item.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('application/myai-file', JSON.stringify({
                        name: file.name,
                        path: file.path
                    }));
                });
            }

            let icon = file.isDirectory ? '📁' : '📄';
            // Specific icons for common types if we want to be fancy
            if (!file.isDirectory) {
                const ext = file.name.split('.').pop().toLowerCase();
                if (['js', 'ts', 'jsx', 'tsx'].includes(ext)) icon = 'JS';
                if (['html', 'css'].includes(ext)) icon = '</>';
                if (['json', 'md'].includes(ext)) icon = '📝';
                if (['xlsx', 'xls', 'csv'].includes(ext)) icon = '📊';
                if (ext === 'pdf') icon = '📕';
            }

            item.innerHTML = `
                <div class="folder-arrow">${file.isDirectory ? '▶' : ''}</div>
                <div class="file-icon">${icon}</div>
                <div class="file-name" title="${file.name}">${file.name}</div>
                ${!file.isDirectory ? '<button class="discuss-btn">Discuss</button>' : ''}
            `;

            if (!file.isDirectory) {
                const discussBtn = item.querySelector('.discuss-btn');
                discussBtn.onclick = async (e) => {
                    e.stopPropagation();
                    const response = await fetch(`/api/files/read?path=${encodeURIComponent(file.path)}`);
                    const data = await response.json();
                    if (data.content) {
                        const isFilesActive = document.getElementById('files-view').classList.contains('active');
                        attachFile(file.name, file.path, data.content, isFilesActive);
                    }
                };
            }

            if (file.isDirectory) {
                const childrenContainer = document.createElement('div');
                childrenContainer.className = 'folder-children';

                item.onclick = (e) => {
                    e.stopPropagation();
                    item.classList.toggle('expanded');
                };

                if (file.children && file.children.length > 0) {
                    renderFileTree(file.children, childrenContainer);
                } else {
                    childrenContainer.innerHTML = '<div class="view-placeholder" style="padding: 0.2rem 1rem; font-size: 0.75rem;">Empty</div>';
                }

                container.appendChild(item);
                container.appendChild(childrenContainer);
            } else {
                item.onclick = (e) => {
                    e.stopPropagation();
                    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
                    item.classList.add('active');
                    trackRecentFile(file.name, file.path);
                    readFile(file.path);
                };
                container.appendChild(item);
            }
        });
    }

    function attachFile(name, filePath, content, isFilesTab, dataUrl) {
        const list = isFilesTab ? filesAttachedFiles : mainAttachedFiles;
        if (list.some(f => f.path === filePath)) return;
        const entry = { name, path: filePath, content };
        if (isImageFile(name)) {
            entry.thumbnailUrl = dataUrl || getImageUrl(filePath);
            if (dataUrl && dataUrl.startsWith('data:')) {
                entry.base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
            }
        }
        list.push(entry);
        trackRecentFile(name, filePath);
        renderAttachedFiles(isFilesTab);
    }

    function removeAttachedFile(path, isFilesTab) {
        if (isFilesTab) {
            filesAttachedFiles = filesAttachedFiles.filter(f => f.path !== path);
        } else {
            mainAttachedFiles = mainAttachedFiles.filter(f => f.path !== path);
        }
        renderAttachedFiles(isFilesTab);
    }

    function renderAttachedFiles(isFilesTab) {
        const containerId = isFilesTab ? 'attached-files-container-files' : 'attached-files-container-main';
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = '';
        const list = isFilesTab ? filesAttachedFiles : mainAttachedFiles;

        list.forEach(file => {
            const chip = document.createElement('div');
            if (file.thumbnailUrl) {
                chip.className = 'file-chip file-chip-image';
                chip.innerHTML = `
                    <img src="${file.thumbnailUrl}" class="file-chip-thumb" alt="${file.name}">
                    <span>${file.name}</span>
                    <span class="file-chip-remove" title="Remove">&times;</span>
                `;
            } else {
                chip.className = 'file-chip';
                chip.innerHTML = `
                    <span class="file-chip-icon">${getFileIcon(file.name)}</span>
                    <span>${file.name}</span>
                    <span class="file-chip-remove" title="Remove">&times;</span>
                `;
            }
            chip.querySelector('.file-chip-remove').onclick = () => removeAttachedFile(file.path, isFilesTab);
            container.appendChild(chip);
        });

        if (isFilesTab) {
            const filesInput = document.getElementById("user-input-files");
            const filesBtn = document.getElementById("send-btn-files");
            if (filesInput && filesBtn) updateSendButtonState(filesInput, filesBtn, true);
        } else {
            updateSendButtonState(userInput, sendBtn, false);
        }
    }

    function setupDragAndDrop(formSelector, isFilesTab, extraDropZoneSelector) {
        const form = document.querySelector(formSelector);
        if (!form) return;

        const dropTargets = [form];
        if (extraDropZoneSelector) {
            const extra = document.querySelector(extraDropZoneSelector);
            if (extra) dropTargets.push(extra);
        }

        dropTargets.forEach(target => {
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
                target.addEventListener(eventName, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                }, false);
            });

            ['dragenter', 'dragover'].forEach(eventName => {
                target.addEventListener(eventName, () => form.classList.add('drag-over'), false);
            });

            ['dragleave', 'drop'].forEach(eventName => {
                target.addEventListener(eventName, () => form.classList.remove('drag-over'), false);
            });

            target.addEventListener('drop', (e) => {
                const internalData = e.dataTransfer.getData('application/myai-file');
                if (internalData) {
                    const fileData = JSON.parse(internalData);
                    fetch(`/api/files/read?path=${encodeURIComponent(fileData.path)}`)
                        .then(res => res.json())
                        .then(data => {
                            if (data.content) {
                                attachFile(fileData.name, fileData.path, data.content, isFilesTab);
                            }
                        });
                } else {
                    const dt = e.dataTransfer;
                    const files = dt.files;
                    handleFileUpload(files, isFilesTab);
                }
            }, false);
        });
    }

    function readFileAsDataUrl(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
        });
    }

    async function handleFileUpload(files, isFilesTab) {
        for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);

            let dataUrl = null;
            if (isImageFile(file.name)) {
                dataUrl = await readFileAsDataUrl(file);
            }

            try {
                const target = isFilesTab ? 'local' : 'temp';
                const response = await fetch(`/api/files/upload?target=${target}`, {
                    method: 'POST',
                    body: formData
                });
                const result = await response.json();
                if (result.success) {
                    if (document.getElementById('files-view').classList.contains('active')) {
                        loadFiles();
                    }

                    if (isImageFile(result.name)) {
                        const thumbUrl = dataUrl || getImageUrl(result.path);
                        attachFile(result.name, result.path, `[Image: ${result.name}]`, isFilesTab, thumbUrl);
                    } else {
                        try {
                            const readRes = await fetch(`/api/files/read?path=${encodeURIComponent(result.path)}`);
                            const readData = await readRes.json();
                            if (readData.error) {
                                console.error(`Failed to read ${result.name}:`, readData.error);
                                alert(`Could not read "${result.name}": ${readData.error}`);
                            } else if (readData.content) {
                                attachFile(result.name, result.path, readData.content, isFilesTab);
                            }
                        } catch (readErr) {
                            console.error(`Error reading uploaded file ${result.name}:`, readErr);
                            alert(`Failed to read "${result.name}" after upload.`);
                        }
                    }
                } else {
                    alert(`Upload failed for "${file.name}": ${result.error || 'Unknown error'}`);
                }
            } catch (error) {
                console.error("Upload error:", error);
                alert(`Failed to upload "${file.name}".`);
            }
        }
    }

    setupDragAndDrop('#chat-form', false, '#chat-container');
    setupDragAndDrop('.chat-form-files', true, '#chat-container-files');

    async function readFile(path) {
        try {
            const response = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);
            const data = await response.json();
            if (data.info) {
                // Future expansion: preview in right pane
            }
            if (data.content) {
                console.log("File content loaded:", data.content);
                alert(`Content of ${path} loaded to console (first 100 chars): ${data.content.substring(0, 100)}...`);
            }
        } catch (error) {
            console.error("Error reading file:", error);
        }
    }

    // Model Installation Logic
    const installModelInput = document.getElementById("install-model-input");
    const installModelBtn = document.getElementById("install-model-btn");
    const installProgressContainer = document.getElementById("install-progress-container");
    const installProgressBar = document.getElementById("install-progress-bar");
    const installStatusText = document.getElementById("install-status-text");

    installModelBtn.addEventListener('click', async () => {
        const modelName = installModelInput.value.trim();
        if (!modelName) return;

        installModelBtn.disabled = true;
        installProgressContainer.style.display = 'block';
        installProgressBar.style.width = '0%';
        installStatusText.textContent = `Starting pull for ${modelName}...`;

        try {
            const response = await fetch('/api/pull', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: modelName, stream: true })
            });

            if (!response.ok) throw new Error("Failed to start model pull");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const data = JSON.parse(line);
                        if (data.status === 'downloading' && data.total) {
                            const percent = Math.round((data.completed / data.total) * 100);
                            installProgressBar.style.width = `${percent}%`;
                            installStatusText.textContent = `Downloading ${modelName}: ${percent}%`;
                        } else if (data.status === 'success') {
                            installStatusText.textContent = `Successfully installed ${modelName}!`;
                            installProgressBar.style.width = '100%';
                            loadModels(); // Refresh model list
                        } else {
                            installStatusText.textContent = data.status || 'Processing...';
                        }
                    } catch (e) {
                        console.error("Error parsing progress chunk", e);
                    }
                }
            }
        } catch (error) {
            console.error("Error installing model:", error);
            installStatusText.textContent = `Error: ${error.message}`;
        } finally {
            installModelBtn.disabled = false;
            setTimeout(() => {
                if (installStatusText.textContent.includes('Success')) {
                    installProgressContainer.style.display = 'none';
                    installModelInput.value = '';
                }
            }, 3000);
        }
    });

    // Model Catalog
    const MODEL_CATALOG = [
        { name: "llama3.2", tag: "3b", size: "2.0 GB", category: "general", desc: "Meta's latest compact model. Fast and capable for everyday tasks, summarization, and Q&A." },
        { name: "llama3.2", tag: "1b", size: "1.3 GB", category: "general", desc: "Ultra-lightweight Llama. Great for quick responses on low-end hardware." },
        { name: "llama3.1", tag: "8b", size: "4.7 GB", category: "general", desc: "Meta's flagship open model. Excellent reasoning, writing, and analysis." },
        { name: "llama3.1", tag: "70b", size: "40 GB", category: "general", desc: "Large-scale Llama. Near-GPT-4 quality for complex reasoning. Requires significant RAM." },
        { name: "gemma2", tag: "2b", size: "1.6 GB", category: "general", desc: "Google's efficient small model. Strong at instruction following and text generation." },
        { name: "gemma2", tag: "9b", size: "5.5 GB", category: "general", desc: "Google's mid-size model. Great balance of quality and speed." },
        { name: "gemma2", tag: "27b", size: "16 GB", category: "general", desc: "Google's largest Gemma. Top-tier quality for open-source models." },
        { name: "qwen2.5", tag: "0.5b", size: "397 MB", category: "general", desc: "Alibaba's smallest model. Ultra-fast, ideal for simple PDF search and low-resource devices." },
        { name: "qwen2.5", tag: "1.5b", size: "986 MB", category: "general", desc: "Balanced small Qwen. Great for quick analysis and summarization." },
        { name: "qwen3.5", tag: "0.8b", size: "550 MB", category: "general", desc: "User-specified Qwen model. Optimized for text analysis and searching." },
        { name: "qwen2.5", tag: "3b", size: "1.9 GB", category: "general", desc: "Alibaba's compact model. Strong multilingual support and math capabilities." },
        { name: "qwen2.5", tag: "7b", size: "4.4 GB", category: "general", desc: "Alibaba's versatile mid-size model. Excellent at structured data and coding." },
        { name: "qwen2.5", tag: "14b", size: "9.0 GB", category: "general", desc: "High-quality general-purpose model with strong analytical skills." },
        { name: "qwen2.5", tag: "32b", size: "20 GB", category: "general", desc: "Premium quality. Exceptional at complex tasks, math, and long-form content." },
        { name: "phi3", tag: "3.8b", size: "2.3 GB", category: "general", desc: "Microsoft's small but mighty model. Punches above its weight for reasoning tasks." },
        { name: "mistral", tag: "7b", size: "4.1 GB", category: "general", desc: "Mistral AI's foundational model. Fast, reliable, great for general conversation." },
        { name: "mixtral", tag: "8x7b", size: "26 GB", category: "general", desc: "Mixture-of-experts model. High quality with efficient inference. Needs more RAM." },
        { name: "deepseek-r1", tag: "7b", size: "4.7 GB", category: "general", desc: "DeepSeek's reasoning model. Shows chain-of-thought before answering." },
        { name: "deepseek-r1", tag: "14b", size: "9.0 GB", category: "general", desc: "Larger reasoning model with stronger analytical and math abilities." },
        { name: "codellama", tag: "7b", size: "3.8 GB", category: "code", desc: "Meta's code-specialized model. Trained for code generation, review, and debugging." },
        { name: "codellama", tag: "13b", size: "7.4 GB", category: "code", desc: "Larger CodeLlama. Better at complex codebases and multi-file reasoning." },
        { name: "codellama", tag: "34b", size: "19 GB", category: "code", desc: "Largest CodeLlama. Best code quality, understands large architectural patterns." },
        { name: "qwen2.5-coder", tag: "3b", size: "1.9 GB", category: "code", desc: "Alibaba's code model. Fast code completion and generation." },
        { name: "qwen2.5-coder", tag: "7b", size: "4.4 GB", category: "code", desc: "Strong coding model. Excellent at multiple programming languages." },
        { name: "qwen2.5-coder", tag: "14b", size: "9.0 GB", category: "code", desc: "Premium code model. Handles complex refactoring and architecture tasks." },
        { name: "deepseek-coder-v2", tag: "16b", size: "8.9 GB", category: "code", desc: "DeepSeek's code specialist. Strong at code generation and technical tasks." },
        { name: "starcoder2", tag: "3b", size: "1.7 GB", category: "code", desc: "BigCode's model trained on The Stack v2. Good for code completion." },
        { name: "starcoder2", tag: "7b", size: "4.0 GB", category: "code", desc: "Larger StarCoder. Supports 600+ programming languages." },
        { name: "llava", tag: "7b", size: "4.7 GB", category: "vision", desc: "Vision-language model. Can analyze images, charts, screenshots, and documents." },
        { name: "llava", tag: "13b", size: "8.0 GB", category: "vision", desc: "Larger LLaVA. More detailed image understanding and description." },
        { name: "llava", tag: "34b", size: "20 GB", category: "vision", desc: "Largest LLaVA. Best visual reasoning and OCR capabilities." },
        { name: "llama3.2-vision", tag: "11b", size: "7.9 GB", category: "vision", desc: "Meta's vision model. Understands images with Llama 3.2 quality text." },
        { name: "moondream", tag: "1.8b", size: "1.0 GB", category: "vision", desc: "Tiny vision model. Fast image analysis on minimal hardware." },
        { name: "nomic-embed-text", tag: "latest", size: "274 MB", category: "embedding", desc: "Text embedding model for semantic search, clustering, and RAG pipelines." },
        { name: "mxbai-embed-large", tag: "latest", size: "670 MB", category: "embedding", desc: "High-quality embeddings. Top performance on retrieval benchmarks." },
        { name: "all-minilm", tag: "latest", size: "46 MB", category: "embedding", desc: "Ultra-small embedding model. Fast and lightweight for basic similarity search." },
    ];

    let installedModelNames = [];

    async function fetchInstalledModels() {
        try {
            const res = await fetch('/api/tags');
            const data = await res.json();
            installedModelNames = (data.models || []).map(m => m.name);
        } catch { installedModelNames = []; }
    }

    function isModelInstalled(name, tag) {
        const full = `${name}:${tag}`;
        return installedModelNames.some(m => m === full || m === `${name}:${tag}` || m.startsWith(`${name}:${tag}-`) || (tag === 'latest' && m === name));
    }

    function renderModelCatalog(filter = 'all') {
        const container = document.getElementById('model-catalog');
        container.innerHTML = '';
        const filtered = filter === 'all' ? MODEL_CATALOG : MODEL_CATALOG.filter(m => m.category === filter);

        filtered.forEach(model => {
            const installed = isModelInstalled(model.name, model.tag);
            const card = document.createElement('div');
            card.className = `model-card${installed ? ' installed' : ''}`;
            card.innerHTML = `
                <div class="model-card-header">
                    <div class="model-card-name">${model.name}<span class="model-card-tag">:${model.tag}</span></div>
                    <span class="model-card-size">${model.size}</span>
                </div>
                <p class="model-card-desc">${model.desc}</p>
                <div class="model-card-footer">
                    <span class="model-card-category">${model.category}</span>
                    ${installed
                        ? '<span class="model-card-installed"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Installed</span>'
                        : `<button class="model-card-install-btn" data-model="${model.name}:${model.tag}">Install</button>`
                    }
                </div>
            `;

            if (!installed) {
                card.querySelector('.model-card-install-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    installModelInput.value = e.target.dataset.model;
                    installModelBtn.click();
                    setTimeout(() => renderModelCatalog(filter), 500);
                });
            }

            container.appendChild(card);
        });
    }

    document.querySelectorAll('.catalog-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.catalog-filter').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderModelCatalog(btn.dataset.filter);
        });
    });

    // Refresh catalog when install completes
    const origInstallClick = installModelBtn.onclick;
    const origListener = installModelBtn.cloneNode(true);

    // Re-render catalog after model install success
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        return response;
    };

    // Refresh catalog when settings tab is opened
    const settingsTab = document.querySelector('.tab-btn[data-target="settings-view"]');
    if (settingsTab) {
        settingsTab.addEventListener('click', async () => {
            await fetchInstalledModels();
            renderModelCatalog(document.querySelector('.catalog-filter.active')?.dataset.filter || 'all');
        });
    }

    // Initial catalog load
    fetchInstalledModels().then(() => renderModelCatalog());

    // Also refresh catalog after successful install
    const origInstallHandler = installModelBtn.onclick;
    const installObserver = new MutationObserver(() => {
        if (installStatusText.textContent.includes('Successfully')) {
            fetchInstalledModels().then(() => {
                loadModels();
                renderModelCatalog(document.querySelector('.catalog-filter.active')?.dataset.filter || 'all');
            });
        }
    });
    installObserver.observe(installStatusText, { childList: true, characterData: true, subtree: true });

    // Top Navigation Tabs Logic
    const tabBtns = document.querySelectorAll('.tab-btn');
    const viewSections = document.querySelectorAll('.view-section');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Remove active class from all tabs and views
            tabBtns.forEach(t => t.classList.remove('active'));
            viewSections.forEach(v => v.classList.remove('active'));

            // Add active class to clicked tab and corresponding view
            btn.classList.add('active');
            const targetId = btn.getAttribute('data-target');
            document.getElementById(targetId).classList.add('active');

            // Sidebar View Swapping
            const chatSidebarView = document.getElementById('chat-sidebar-view');
            const filesSidebarView = document.getElementById('files-sidebar-view');

            if (targetId === 'files-view') {
                chatSidebarView.classList.remove('active');
                filesSidebarView.classList.add('active');
                loadFiles();
            } else {
                filesSidebarView.classList.remove('active');
                chatSidebarView.classList.add('active');
            }
        });
    });

    // Configuration Logic
    const filesDirInput = document.getElementById("files-dir-input");
    const saveConfigBtn = document.getElementById("save-config-btn");
    const filesPathLabel = document.getElementById("files-path-label");

    async function loadConfig() {
        try {
            const response = await fetch('/api/config');
            const config = await response.json();
            if (config.filesDir) {
                filesDirInput.value = config.filesDir;
                filesPathLabel.textContent = config.filesDir;
            }
        } catch (e) { console.error("Error loading config:", e); }
    }

    saveConfigBtn.addEventListener('click', async () => {
        const newPath = filesDirInput.value.trim();
        if (!newPath) return;

        saveConfigBtn.disabled = true;
        try {
            const response = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filesDir: newPath })
            });
            const config = await response.json();
            filesPathLabel.textContent = config.filesDir;
            alert("Settings saved successfully!");
            if (document.getElementById('files-view').classList.contains('active')) {
                loadFiles();
            }
        } catch (e) {
            console.error("Error saving config:", e);
            alert("Failed to save settings.");
        } finally {
            saveConfigBtn.disabled = false;
        }
    });

    // Init
    loadModels();
    loadConfig();
    loadChatHistory();
    renderRecentFiles();
});
