import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { MiniApp } from './MiniApp'
import './styles.css'

const isMini = window.location.hash === '#mini'
if (isMini) document.body.classList.add('mini')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isMini ? <MiniApp /> : <App />}
  </React.StrictMode>,
)
