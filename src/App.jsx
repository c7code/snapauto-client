import React, { useState, useEffect, useRef } from 'react'
import { jsPDF } from 'jspdf'

// API base URL configurable via env; fallback to local dev
const API_BASE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/+$/, '')

function App() {
  const [file, setFile] = useState(null)
  const [intervalSec, setIntervalSec] = useState(1)
  const [loading, setLoading] = useState(false)
  const [images, setImages] = useState([])
  const [error, setError] = useState('')
  const [jobId, setJobId] = useState('')
  const [evaluating, setEvaluating] = useState(false)
  const [evaluation, setEvaluation] = useState(null)
  const pollIntervalRef = useRef(null)
  const timeoutRef = useRef(null)
  const handleDownloadReport = () => {
    try {
      let parsed = evaluation?.result || evaluation || {}
      if (parsed && typeof parsed.raw === 'string') {
        try {
          const rawParsed = JSON.parse(parsed.raw)
          parsed = { ...parsed, ...rawParsed }
          delete parsed.raw
        } catch {}
      }

      const doc = new jsPDF()
      const pageWidth = doc.internal.pageSize.getWidth()
      const pageHeight = doc.internal.pageSize.getHeight()
      let y = 20
      const addLine = (text, size = 12, bold = false) => {
        doc.setFont('helvetica', bold ? 'bold' : 'normal')
        doc.setFontSize(size)
        const lines = doc.splitTextToSize(text, pageWidth - 30)
        lines.forEach((line) => {
          if (y > pageHeight - 20) {
            doc.addPage()
            y = 20
          }
          doc.text(line, 15, y)
          y += 6
        })
      }

      addLine('Relatório de Avaliação do Estado de Conservação', 16, true)
      addLine(`ID: ${jobId || 'N/A'}`)
      addLine(`Data: ${new Date().toLocaleString()}`)
      addLine('')

      if (parsed.overall_score !== undefined) {
        addLine(`Pontuação Geral: ${parsed.overall_score}/100`, 14, true)
      }
      if (parsed.conservation_status) {
        addLine(`Estado de Conservação: ${parsed.conservation_status}`)
      }
      if (parsed.legal_status) {
        addLine(`Status Legal: ${parsed.legal_status}`)
        if (parsed.legal_status_reason) addLine(`Motivo: ${parsed.legal_status_reason}`)
      }
      addLine('')

      const categories = [
        ['Carroceria', parsed.bodywork_score],
        ['Pintura', parsed.paint_score],
        ['Vidros/Faróis', parsed.glass_lights_score],
        ['Pneus/Rodas', parsed.tires_wheels_score],
        ['Interior', parsed.interior_score],
      ]
      addLine('Avaliação por Categoria', 14, true)
      categories.forEach(([label, score]) => {
        if (score !== undefined && score !== null) addLine(`${label}: ${score}/100`)
      })
      addLine('')

      if (Array.isArray(parsed.damages_detected) && parsed.damages_detected.length) {
        addLine('Danos Detectados', 14, true)
        parsed.damages_detected.forEach((d) => addLine(`• ${d}`))
        addLine('')
      }

      if (Array.isArray(parsed.recommendations) && parsed.recommendations.length) {
        addLine('Recomendações', 14, true)
        parsed.recommendations.forEach((r) => addLine(`• ${r}`))
        addLine('')
      }

      if (Array.isArray(parsed.best_frames) && parsed.best_frames.length) {
        addLine('Frames Utilizados na Análise', 14, true)
        parsed.best_frames.forEach((f, i) => addLine(`${i + 1}. ${f.filename || 'Frame'}: ${f.reason || ''}`))
      }

      doc.save(`avaliacao-${jobId || 'veiculo'}.pdf`)
    } catch (e) {}
  }
  
  // Limpa intervalos quando o componente desmonta
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setImages([])
    if (!file) {
      setError('Selecione um vídeo')
      return
    }
    const form = new FormData()
    form.append('video', file)
    form.append('intervalSec', String(intervalSec))
    try {
      setLoading(true)
      const res = await fetch(`${API_BASE_URL}/upload`, {
        method: 'POST',
        body: form,
      })
      if (!res.ok) throw new Error('Falha ao processar vídeo')
      const data = await res.json()
      setImages(data.frames || [])
      setJobId(data.id || '')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleEvaluate = async () => {
    setError('')
    setEvaluation(null)
    if (!jobId) {
      setError('Nenhum conjunto de frames para avaliar')
      return
    }
    try {
      setEvaluating(true)
      
      // Adiciona na fila
      const res = await fetch(`${API_BASE_URL}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: jobId, maxFrames: 12 }),
      })
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}))
        throw new Error(errorData.error || `Erro ${res.status}: Falha ao adicionar avaliação na fila`)
      }
      
      // Limpa intervalos anteriores se existirem
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      
      // Faz polling para verificar o status
      pollIntervalRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`${API_BASE_URL}/evaluate/${jobId}`)
          if (!statusRes.ok) {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
            if (timeoutRef.current) clearTimeout(timeoutRef.current)
            throw new Error('Falha ao verificar status')
          }
          
          const statusData = await statusRes.json()
          
          if (statusData.status === 'completed') {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
            if (timeoutRef.current) clearTimeout(timeoutRef.current)
            setEvaluation(statusData.result)
            setEvaluating(false)
          } else if (statusData.status === 'failed') {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
            if (timeoutRef.current) clearTimeout(timeoutRef.current)
            setError(statusData.error || 'Falha ao avaliar imagens')
            setEvaluating(false)
          }
          // Se ainda está pending ou processing, continua o polling
        } catch (err) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
          if (timeoutRef.current) clearTimeout(timeoutRef.current)
          setError(err.message)
          setEvaluating(false)
        }
      }, 2000) // Verifica a cada 2 segundos
      
      // Timeout de segurança (5 minutos)
      timeoutRef.current = setTimeout(() => {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
        setError('Timeout: A avaliação está demorando muito. Tente novamente.')
        setEvaluating(false)
      }, 5 * 60 * 1000)
      
    } catch (err) {
      setError(err.message)
      setEvaluating(false)
    }
  }

  return (
    <div className="min-h-full">
      <div className="max-w-7xl mx-auto p-6">
        <h1 className="text-2xl font-semibold mb-4">snapAuto</h1>
        <form onSubmit={handleSubmit} className="space-y-4 bg-white p-4 rounded shadow">
          <div>
            <label className="block text-sm font-medium mb-1">Vídeo</label>
            <input
              type="file"
              accept="video/*"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Intervalo (segundos)</label>
            <input
              type="number"
              min="1"
              value={intervalSec}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
              className="w-32 rounded border px-2 py-1"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? 'Processando...' : 'Enviar'}
          </button>
          {error && <p className="text-red-600 text-sm">{error}</p>}
        </form>

        {!!images.length && (
          <div className="mt-4">
            <button
              onClick={handleEvaluate}
              disabled={evaluating}
              className="inline-flex items-center rounded bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {evaluating ? 'Avaliando estado de conservação...' : 'Avaliar estado de conservação do veículo'}
            </button>
          </div>
        )}

        {/* Layout de duas colunas quando há imagens */}
        {!!images.length && (
          <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Coluna esquerda: Imagens */}
            <div>
              <h2 className="text-lg font-semibold mb-4">Frames Extraídos</h2>
              <div className="grid grid-cols-2 gap-4">
                {images.map((src, i) => (
                  <img key={i} src={src} alt={`frame-${i}`} className="w-full h-auto rounded border" />
                ))}
              </div>
            </div>

            {/* Coluna direita: Avaliação */}
            <div className="bg-white rounded shadow min-h-[400px]">
              {evaluation ? (() => {
          // Parseia o JSON corretamente, incluindo o campo 'raw' se existir
          let parsedResult = evaluation.result || evaluation
          
          // Se o resultado tem um campo 'raw' (string JSON), tenta parsear
          if (parsedResult && typeof parsedResult.raw === 'string') {
            try {
              const rawParsed = JSON.parse(parsedResult.raw)
              parsedResult = { ...parsedResult, ...rawParsed }
              delete parsedResult.raw
            } catch (e) {
              // Se não conseguir parsear, mantém como está
              console.warn('Não foi possível parsear o campo raw:', e)
            }
          }
          
          const result = parsedResult
          const evaluationId = evaluation.id || 'N/A'
          const files = evaluation.files || []
          
          return (
            <div className="p-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold">Avaliação do Estado de Conservação</h2>
                <button
                  onClick={handleDownloadReport}
                  className="inline-flex items-center rounded bg-indigo-600 px-3 py-2 text-white hover:bg-indigo-700"
                >
                  Baixar avaliação (PDF)
                </button>
              </div>
              
              {/* Informações Gerais */}
              <div className="mb-4 p-3 bg-gray-50 rounded text-sm">
                <p><strong>ID da Avaliação:</strong> {evaluationId}</p>
                {files.length > 0 && (
                  <p className="mt-1"><strong>Frames Analisados:</strong> {files.join(', ')}</p>
                )}
              </div>
              
              {/* Status Legal */}
              {result.legal_status && (
                <div className={`mb-4 p-4 rounded-lg border-2 ${
                  result.legal_status === 'aprovado' ? 'bg-green-50 border-green-500' :
                  result.legal_status === 'condicionado' ? 'bg-yellow-50 border-yellow-500' :
                  'bg-red-50 border-red-500'
                }`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-bold text-lg">
                      Status Legal: {result.legal_status.toUpperCase()}
                    </span>
                    {result.overall_score !== undefined && (
                      <span className="text-2xl font-bold">
                        {result.overall_score}/100
                      </span>
                    )}
                  </div>
                  {result.legal_status_reason && (
                    <p className="text-sm mt-2">{result.legal_status_reason}</p>
                  )}
                </div>
              )}

              {/* Estado de Conservação */}
              {result.conservation_status && (
                <div className="mb-4 p-3 bg-blue-50 rounded">
                  <h3 className="font-semibold mb-1">Estado de Conservação Geral</h3>
                  <p className="text-lg capitalize font-medium">{result.conservation_status}</p>
                </div>
              )}

              {/* Scores por Categoria */}
              {(result.bodywork_score !== undefined || result.paint_score !== undefined || 
                result.glass_lights_score !== undefined || result.tires_wheels_score !== undefined) && (
                <div className="mb-4">
                  <h3 className="font-semibold mb-3">Avaliação por Categoria</h3>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {result.bodywork_score !== undefined && (
                      <div className="bg-gray-50 p-3 rounded border">
                        <div className="text-xs text-gray-600 mb-1">Carroceria</div>
                        <div className="text-lg font-semibold">{result.bodywork_score}/100</div>
                      </div>
                    )}
                    {result.paint_score !== undefined && (
                      <div className="bg-gray-50 p-3 rounded border">
                        <div className="text-xs text-gray-600 mb-1">Pintura</div>
                        <div className="text-lg font-semibold">{result.paint_score}/100</div>
                      </div>
                    )}
                    {result.glass_lights_score !== undefined && (
                      <div className="bg-gray-50 p-3 rounded border">
                        <div className="text-xs text-gray-600 mb-1">Vidros/Faróis</div>
                        <div className="text-lg font-semibold">{result.glass_lights_score}/100</div>
                      </div>
                    )}
                    {result.tires_wheels_score !== undefined && (
                      <div className="bg-gray-50 p-3 rounded border">
                        <div className="text-xs text-gray-600 mb-1">Pneus/Rodas</div>
                        <div className="text-lg font-semibold">{result.tires_wheels_score}/100</div>
                      </div>
                    )}
                    {result.interior_score !== undefined && result.interior_score !== null && (
                      <div className="bg-gray-50 p-3 rounded border">
                        <div className="text-xs text-gray-600 mb-1">Interior</div>
                        <div className="text-lg font-semibold">{result.interior_score}/100</div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Danos Detectados */}
              {result.damages_detected && result.damages_detected.length > 0 && (
                <div className="mb-4 p-4 bg-red-50 rounded border border-red-200">
                  <h3 className="font-semibold mb-2 text-red-700">Danos Detectados</h3>
                  <ul className="list-disc list-inside space-y-1 text-sm">
                    {result.damages_detected.map((damage, i) => (
                      <li key={i} className="text-red-800">{damage}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Recomendações */}
              {result.recommendations && result.recommendations.length > 0 && (
                <div className="mb-4 p-4 bg-blue-50 rounded border border-blue-200">
                  <h3 className="font-semibold mb-2 text-blue-700">Recomendações</h3>
                  <ul className="list-disc list-inside space-y-1 text-sm">
                    {result.recommendations.map((rec, i) => (
                      <li key={i} className="text-blue-800">{rec}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Melhores Frames */}
              {result.best_frames && result.best_frames.length > 0 && (
                <div className="mb-4 p-3 bg-gray-50 rounded">
                  <h3 className="font-semibold mb-2">Frames Utilizados na Análise</h3>
                  <ul className="space-y-2 text-sm">
                    {result.best_frames.map((frame, i) => (
                      <li key={i} className="bg-white p-2 rounded border">
                        <span className="font-medium text-gray-700">{frame.filename || `Frame ${i + 1}`}:</span>
                        <span className="ml-2 text-gray-600">{frame.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Resumo em Texto */}
              <div className="mt-6 p-5 bg-gradient-to-r from-gray-50 to-gray-100 rounded-lg border-2 border-gray-200">
                <h3 className="font-bold text-lg mb-4 text-gray-800 border-b pb-2">Relatório Completo da Avaliação</h3>
                <div className="space-y-3 text-base text-gray-700 leading-relaxed">
                  {result.overall_score !== undefined && (
                    <div className="bg-white p-3 rounded border-l-4 border-blue-500">
                      <p className="mb-1">
                        <strong className="text-gray-900">Pontuação Geral:</strong> <span className="text-xl font-bold text-blue-600">{result.overall_score}/100</span>
                      </p>
                      {result.conservation_status && (
                        <p className="text-sm text-gray-600">
                          Estado de conservação: <span className="capitalize font-medium">{result.conservation_status}</span>
                        </p>
                      )}
                    </div>
                  )}
                  
                  {result.legal_status && (
                    <div className="bg-white p-3 rounded border-l-4 border-green-500">
                      <p className="mb-1">
                        <strong className="text-gray-900">Status Legal:</strong> <span className="uppercase font-bold text-green-600">{result.legal_status}</span>
                      </p>
                      {result.legal_status_reason && (
                        <p className="text-sm text-gray-600 mt-1">{result.legal_status_reason}</p>
                      )}
                    </div>
                  )}
                  
                  {(result.bodywork_score !== undefined || result.paint_score !== undefined || 
                    result.glass_lights_score !== undefined || result.tires_wheels_score !== undefined || 
                    result.interior_score !== undefined) && (
                    <div className="bg-white p-3 rounded border-l-4 border-purple-500">
                      <p className="mb-2"><strong className="text-gray-900">Avaliação Detalhada por Componente:</strong></p>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                        {result.bodywork_score !== undefined && (
                          <p>• <strong>Carroceria:</strong> {result.bodywork_score}/100</p>
                        )}
                        {result.paint_score !== undefined && (
                          <p>• <strong>Pintura:</strong> {result.paint_score}/100</p>
                        )}
                        {result.glass_lights_score !== undefined && (
                          <p>• <strong>Vidros e Faróis:</strong> {result.glass_lights_score}/100</p>
                        )}
                        {result.tires_wheels_score !== undefined && (
                          <p>• <strong>Pneus e Rodas:</strong> {result.tires_wheels_score}/100</p>
                        )}
                        {result.interior_score !== undefined && result.interior_score !== null && (
                          <p>• <strong>Interior:</strong> {result.interior_score}/100</p>
                        )}
                      </div>
                    </div>
                  )}
                  
                  {result.damages_detected && result.damages_detected.length > 0 && (
                    <div className="bg-white p-3 rounded border-l-4 border-red-500">
                      <p className="mb-2"><strong className="text-gray-900">Danos Identificados:</strong></p>
                      <ul className="list-disc list-inside space-y-1 text-sm">
                        {result.damages_detected.map((damage, i) => (
                          <li key={i} className="text-red-700">{damage}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  
                  {result.recommendations && result.recommendations.length > 0 && (
                    <div className="bg-white p-3 rounded border-l-4 border-blue-500">
                      <p className="mb-2"><strong className="text-gray-900">Recomendações:</strong></p>
                      <ul className="list-disc list-inside space-y-1 text-sm">
                        {result.recommendations.map((rec, i) => (
                          <li key={i} className="text-blue-700">{rec}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  
                  {result.best_frames && result.best_frames.length > 0 && (
                    <div className="bg-white p-3 rounded border-l-4 border-gray-400">
                      <p className="mb-2"><strong className="text-gray-900">Frames Utilizados na Análise:</strong></p>
                      <ul className="space-y-1 text-sm">
                        {result.best_frames.map((frame, i) => (
                          <li key={i} className="text-gray-600">
                            • <strong>{frame.filename || `Frame ${i + 1}`}:</strong> {frame.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })() : (
          <div className="p-6 text-center text-gray-500">
            <p className="text-lg mb-2">Avaliação do Estado de Conservação</p>
            <p className="text-sm">Clique no botão acima para avaliar o veículo</p>
          </div>
        )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default App
