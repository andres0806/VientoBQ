---
name: physics-sim
description: Motor matemático para simular la cinemática de ciclistas, integrar resistencia aerodinámica y estimar el esfuerzo físico en tiempo real.
---

# Reglas del Motor Físico y Cinemático

Al desarrollar la lógica y los algoritmos matemáticos del simulador de ciclismo, aplica estrictamente estas reglas:

## 1. Sistema de Unidades y Constantes
- **Cálculo interno:** Usa el Sistema Internacional (SI) para todo el estado de la aplicación. Masa en $kg$, Distancia en $m$, Tiempo en $s$, Velocidad en $m/s$, Aceleración en $m/s^2$, Fuerza en $N$, Potencia en $W$.
- **Interfaz de usuario (UI):** Convierte la velocidad a $km/h$ únicamente al renderizar los datos en pantalla.
- **Constantes locales:** 
  - Gravedad ($g$): $9.81$ $m/s^2$.
  - Densidad del aire a nivel del mar ($\rho$): $1.18$ $kg/m^3$.

## 2. Análisis Dinámico de Fuerzas
Calcula la Fuerza Neta ($F_{neta} = m \cdot a$) integrando los cuatro vectores fundamentales:
- **Tracción ($F_t$):** Fuerza de pedaleo aplicada por el usuario.
- **Resistencia Aerodinámica ($F_a$):** Aplica la fórmula cuadrática $F_a = \frac{1}{2} \rho C_d A (v \pm v_{viento})^2$. Suma $v_{viento}$ si las ráfagas costeras están en contra.
- **Componente Gravitacional ($F_p$):** Derivada de la pendiente del terreno. $F_p = m \cdot g \cdot \sin(\theta)$.
- **Fricción de Rodadura ($F_r$):** $F_r = \mu \cdot m \cdot g \cdot \cos(\theta)$.

## 3. Integración Numérica (MRUA Variable)
- El esfuerzo no es lineal. No uses fórmulas estáticas de velocidad constante.
- Implementa un bucle discreto (Integración de Euler) con un $\Delta t$ pequeño (ej. $0.1s$) para actualizar el estado del ciclista en cada tramo de la ruta.
- Algoritmo de actualización iterativa:
  1. $a = \frac{F_{neta}}{m}$
  2. $v_{nueva} = v_{actual} + a \cdot \Delta t$
  3. $x_{nueva} = x_{actual} + v_{actual} \cdot \Delta t$

## 4. Indicador de Esfuerzo Físico
- Calcula la Potencia Mecánica instantánea requerida: $P = F_t \cdot v$.
- Acumula el Trabajo total (Joules) integrando la potencia en el tiempo. Usa esta variable para alimentar la gráfica de "Reducción del Esfuerzo" en la interfaz.