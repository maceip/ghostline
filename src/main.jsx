import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { installZode } from './bridge/zode.js'
import './index.css'

installZode()

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
