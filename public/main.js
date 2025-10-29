document.addEventListener('DOMContentLoaded', function() {
    const youtubeUrlInput = document.getElementById('youtubeUrl');
    const createProjectBtn = document.getElementById('createProject');
    const resultDiv = document.getElementById('result');
    const shareUrlInput = document.getElementById('shareUrl');
    const copyUrlBtn = document.getElementById('copyUrl');
    const openProjectLink = document.getElementById('openProject');

    createProjectBtn.addEventListener('click', createProject);
    copyUrlBtn.addEventListener('click', copyToClipboard);

    async function createProject() {
        const youtubeUrl = youtubeUrlInput.value.trim();

        if (!youtubeUrl) {
            alert('Пожалуйста, введите ссылку на YouTube видео');
            return;
        }

        if (!isValidYouTubeUrl(youtubeUrl)) {
            alert('Пожалуйста, введите корректную ссылку на YouTube');
            return;
        }

        createProjectBtn.textContent = 'Создание...';
        createProjectBtn.disabled = true;

        try {
            const response = await fetch('/api/projects', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ youtube_url: youtubeUrl })
            });

            if (!response.ok) {
                throw new Error('Ошибка при создании проекта');
            }

            const data = await response.json();

            shareUrlInput.value = data.share_url;
            openProjectLink.href = `/project/${data.project_id}`;

            resultDiv.style.display = 'block';

        } catch (error) {
            console.error('Error:', error);
            alert('Произошла ошибка при создании проекта');
        } finally {
            createProjectBtn.textContent = 'Создать проект';
            createProjectBtn.disabled = false;
        }
    }

    function copyToClipboard() {
        shareUrlInput.select();
        document.execCommand('copy');

        const originalText = copyUrlBtn.textContent;
        copyUrlBtn.textContent = 'Скопировано!';
        setTimeout(() => {
            copyUrlBtn.textContent = originalText;
        }, 2000);
    }

    function isValidYouTubeUrl(url) {
        const regex = /^(https?\:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/[\w\-]+/;
        return regex.test(url);
    }
});