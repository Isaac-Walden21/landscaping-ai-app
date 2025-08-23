let mediaRecorder;
let recordedChunks = [];

document.getElementById('startBtn').onclick = async function() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    let options;
    if (MediaRecorder.isTypeSupported('audio/webm')) {
        options = { mimeType: 'audio/webm' };
    } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        options = { mimeType: 'audio/mp4' };
    } else {
        options = {};
    }
    
    mediaRecorder = new MediaRecorder(stream, options);
    recordedChunks = [];
    
    mediaRecorder.ondataavailable = function(event) {
        recordedChunks.push(event.data);
    };
    
    mediaRecorder.onstop = async function() {
        const mimeType = mediaRecorder.mimeType || 'audio/webm';
        const audioBlob = new Blob(recordedChunks, { type: mimeType });
        await sendAudioToServer(audioBlob);
    };
    
    mediaRecorder.start();
    updateStatus('🎤 Recording customer conversation...', 'recording');
    document.getElementById('startBtn').disabled = true;
    document.getElementById('stopBtn').disabled = false;
    document.getElementById('results').style.display = 'none';
};

document.getElementById('stopBtn').onclick = function() {
    mediaRecorder.stop();
    updateStatus('⏳ Transcribing and analyzing...', 'processing');
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
};

async function sendAudioToServer(audioBlob) {
    try {
        const formData = new FormData();
        
        let filename = 'recording.webm';
        if (audioBlob.type.includes('mp4')) {
            filename = 'recording.mp4';
        }
        
        formData.append('audio', audioBlob, filename);
        
        const response = await fetch('/transcribe', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (result.text && result.analysis && result.estimate) {
            displayResults(result.text, result.analysis);
            displayEstimate(result.estimate);
            updateStatus('✅ Analysis and estimate complete!', 'complete');
        } else {
            updateStatus('❌ No speech detected or processing failed', 'error');
        }
        
    } catch (error) {
        console.error('Error:', error);
        updateStatus('❌ Something went wrong', 'error');
    }
}

function updateStatus(message, type) {
    const statusEl = document.getElementById('status');
    statusEl.textContent = message;
    statusEl.className = '';
    
    if (type === 'recording') statusEl.classList.add('status-recording');
    else if (type === 'processing') statusEl.classList.add('status-processing');
    else if (type === 'complete') statusEl.classList.add('status-complete');
}

function displayResults(transcription, analysis) {
    // Show transcription
    document.getElementById('transcription').textContent = transcription;
    
    // Show analysis results
    document.getElementById('projectSummary').textContent = analysis.projectSummary || 'No summary available';
    
    // Services
    const servicesList = document.getElementById('services');
    servicesList.innerHTML = '';
    (analysis.services || []).forEach(service => {
        const li = document.createElement('li');
        li.textContent = service;
        servicesList.appendChild(li);
    });
    
    // Materials
    const materialsList = document.getElementById('materials');
    materialsList.innerHTML = '';
    (analysis.materials || []).forEach(material => {
        const li = document.createElement('li');
        li.textContent = material;
        materialsList.appendChild(li);
    });
    
    // Problem areas
    const problemsList = document.getElementById('problemAreas');
    problemsList.innerHTML = '';
    (analysis.problemAreas || []).forEach(problem => {
        const li = document.createElement('li');
        li.textContent = problem;
        problemsList.appendChild(li);
    });
    
    // Project scope and duration
    document.getElementById('projectScope').textContent = analysis.projectScope || 'Unknown';
    document.getElementById('estimatedDuration').textContent = analysis.estimatedDuration || 'TBD';
    
    // Notes
    const notesList = document.getElementById('notes');
    notesList.innerHTML = '';
    (analysis.notes || []).forEach(note => {
        const li = document.createElement('li');
        li.textContent = note;
        notesList.appendChild(li);
    });
    
    // Show the results section
    document.getElementById('results').style.display = 'block';
}

function displayEstimate(estimate) {
    if (estimate.error) {
        document.getElementById('estimate-content').innerHTML = 
            `<div style="color: red; padding: 20px;">Estimate generation failed: ${estimate.message}</div>`;
        return;
    }

    // Project overview
    document.getElementById('projectOverview').innerHTML = `
        <p><strong>Summary:</strong> ${estimate.projectInfo.summary}</p>
        <p><strong>Scope:</strong> ${estimate.projectInfo.scope}</p>
        <p><strong>Duration:</strong> ${estimate.projectInfo.estimatedDuration}</p>
        <p><strong>Total Hours:</strong> ${estimate.pricing.totalHours}</p>
    `;

    // Service items
    const serviceTableBody = document.querySelector('#serviceTable tbody');
    serviceTableBody.innerHTML = '';
    estimate.serviceItems.forEach(item => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${item.description}</td>
            <td>${item.quantity}</td>
            <td>${item.unit}</td>
            <td>$${item.rate.toFixed(2)}</td>
            <td>${item.hours}</td>
            <td>$${item.subtotal.toFixed(2)}</td>
        `;
        serviceTableBody.appendChild(row);
    });

    // Material items
    const materialTableBody = document.querySelector('#materialTable tbody');
    materialTableBody.innerHTML = '';
    estimate.materialItems.forEach(item => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${item.description}</td>
            <td>${item.quantity}</td>
            <td>${item.unit}</td>
            <td>$${item.cost.toFixed(2)}</td>
            <td>$${item.subtotal.toFixed(2)}</td>
        `;
        materialTableBody.appendChild(row);
    });

    // Totals
    document.getElementById('laborSubtotal').textContent = `$${estimate.pricing.laborSubtotal.toFixed(2)}`;
    document.getElementById('materialSubtotal').textContent = `$${estimate.pricing.materialSubtotal.toFixed(2)}`;
    document.getElementById('materialMarkup').textContent = `$${estimate.pricing.materialMarkup.toFixed(2)}`;
    document.getElementById('subtotal').textContent = `$${estimate.pricing.subtotal.toFixed(2)}`;
    document.getElementById('tax').textContent = `$${estimate.pricing.tax.toFixed(2)}`;
    document.getElementById('finalTotal').textContent = `$${estimate.pricing.total.toFixed(2)}`;

    // Assumptions and recommendations
    document.getElementById('estimateAssumptions').innerHTML = `
        <p><strong>Assumptions:</strong></p>
        <ul>${estimate.metadata.assumptions.map(a => `<li>${a}</li>`).join('')}</ul>
    `;
    
    document.getElementById('recommendedMeasurements').innerHTML = `
        <p><strong>Recommended on-site measurements:</strong></p>
        <ul>${estimate.metadata.recommendedMeasurements.map(m => `<li>${m}</li>`).join('')}</ul>
    `;
}