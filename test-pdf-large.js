const { PDFParse } = require('pdf-parse');
const fs = require('fs');
const path = require('path');

async function testExtraction() {
    try {
        const filePath = path.join('c:\\Users\\danie\\Documents\\My_Projects\\chatgpt20\\files', '5201-midterm-25w-soln.pdf');
        const dataBuffer = fs.readFileSync(filePath);
        const parser = new PDFParse({ data: dataBuffer });
        const pdfData = await parser.getText();
        await parser.destroy();
        console.log('Extracted text length:', pdfData.text.length);
        console.log('First 500 chars:', pdfData.text.substring(0, 500));
    } catch (e) {
        console.error('Extraction failed:', e);
    }
}

testExtraction();
