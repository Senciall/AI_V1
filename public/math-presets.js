/* ══════════════════════════════════════════════════════════════
   MATH PRESETS — Pre-built visualizations by course
   type: 'jsx' uses JSXGraph (2D), 'plotly' uses Plotly (3D/contour)
   JSX code receives: board, JXG
   Plotly code receives: container (div element), Plotly
   ══════════════════════════════════════════════════════════════ */

const MATH_PRESETS = [

  // ─── CALCULUS 1 ────────────────────────────────────────────
  {
    id: 'c1-limits', course: 'Calc 1', name: 'Limits & Continuity',
    latex: '\\lim_{x \\to a} f(x) = L',
    tags: ['limit', 'continuity', 'lim'],
    type: 'jsx',
    code: `
var a = board.create('slider', [[-8,9],[0,9],[-6,2,6]], {name:'a', snapWidth:0.1, label:{fontSize:14}});
var f = function(x){ return (x*x - 4)/(x - 2); };
board.create('functiongraph', [f, -10, 1.999], {strokeColor:'#7B8CDE', strokeWidth:2});
board.create('functiongraph', [f, 2.001, 10], {strokeColor:'#7B8CDE', strokeWidth:2});
board.create('point', [2, 4], {name:'hole', color:'#E06C6C', size:4, fillColor:'#1F1F1F', strokeColor:'#E06C6C', strokeWidth:2});
var tracer = board.create('point', [function(){return a.Value()}, function(){return f(a.Value())}], {name:'f(a)', color:'#5BB98C', size:3});
board.create('text', [-9,-8, function(){return 'f('+a.Value().toFixed(1)+') = '+f(a.Value()).toFixed(3)}], {fontSize:14});
`
  },
  {
    id: 'c1-derivative', course: 'Calc 1', name: 'Derivative (Tangent Line)',
    latex: "f'(x) = \\lim_{h \\to 0} \\frac{f(x+h)-f(x)}{h}",
    tags: ['derivative', 'tangent', 'slope', "f'"],
    type: 'jsx',
    code: `
var a = board.create('slider', [[-8,9],[2,9],[-5,1,5]], {name:'x\\u2080', snapWidth:0.1, label:{fontSize:14}});
var h = board.create('slider', [[-8,8],[2,8],[0.01,2,4]], {name:'h', snapWidth:0.01, label:{fontSize:14}});
var f = function(x){ return 0.15*x*x*x - 0.8*x + 2; };
var df = function(x){ return 0.45*x*x - 0.8; };
board.create('functiongraph', [f], {strokeColor:'#7B8CDE', strokeWidth:2, name:'f(x)'});
var P = board.create('point', [function(){return a.Value()}, function(){return f(a.Value())}], {name:'P', color:'#E06C6C', size:4});
var Q = board.create('point', [function(){return a.Value()+h.Value()}, function(){return f(a.Value()+h.Value())}], {name:'Q', color:'#D4A843', size:3});
board.create('line', [P, Q], {strokeColor:'#D4A843', strokeWidth:1, dash:2, name:'secant'});
board.create('tangent', [board.create('glider', [function(){return a.Value()}, function(){return f(a.Value())}, board.create('functiongraph',[f],{visible:false})])], {strokeColor:'#5BB98C', strokeWidth:2, name:'tangent'});
board.create('text', [-9,-8, function(){var slope=( f(a.Value()+h.Value()) - f(a.Value()) ) / h.Value(); return 'Secant slope = '+slope.toFixed(3)+'  |  True slope = '+df(a.Value()).toFixed(3)}], {fontSize:13});
`
  },
  {
    id: 'c1-power-rule', course: 'Calc 1', name: 'Power Rule',
    latex: '\\frac{d}{dx}x^n = nx^{n-1}',
    tags: ['power rule', 'polynomial'],
    type: 'jsx',
    code: `
var n = board.create('slider', [[-8,9],[2,9],[0.5,2,5]], {name:'n', snapWidth:0.1, label:{fontSize:14}});
board.create('functiongraph', [function(x){return Math.pow(Math.abs(x),n.Value())*Math.sign(Math.pow(x,n.Value()||1))}], {strokeColor:'#7B8CDE', strokeWidth:2});
board.create('functiongraph', [function(x){return n.Value()*Math.pow(Math.abs(x),n.Value()-1)*Math.sign(Math.pow(x,n.Value()-1||1))}], {strokeColor:'#E06C6C', strokeWidth:2, dash:3});
board.create('text', [-9,8, function(){return 'f(x) = x^{'+n.Value().toFixed(1)+'}'}], {fontSize:15, color:'#7B8CDE'});
board.create('text', [-9,7, function(){return "f'(x) = "+n.Value().toFixed(1)+'x^{'+(n.Value()-1).toFixed(1)+'}'}], {fontSize:15, color:'#E06C6C'});
`
  },
  {
    id: 'c1-riemann', course: 'Calc 1', name: 'Riemann Sum',
    latex: '\\int_a^b f(x)\\,dx \\approx \\sum_{i=1}^n f(x_i^*)\\Delta x',
    tags: ['integral', 'riemann', 'area', 'sum'],
    type: 'jsx',
    code: `
var N = board.create('slider', [[-8,9],[2,9],[1,6,40]], {name:'n', snapWidth:1, label:{fontSize:14}});
var A = board.create('slider', [[-8,8],[2,8],[-5,-1,3]], {name:'a', snapWidth:0.1, label:{fontSize:14}});
var B = board.create('slider', [[-8,7],[2,7],[-2,4,8]], {name:'b', snapWidth:0.1, label:{fontSize:14}});
var f = function(x){return 0.1*x*x*x - 0.5*x + 3;};
board.create('functiongraph', [f], {strokeColor:'#7B8CDE', strokeWidth:2});
board.create('riemannsum', [f, function(){return N.Value()}, 'left', function(){return A.Value()}, function(){return B.Value()}], {fillColor:'#7B8CDE', fillOpacity:0.25, strokeColor:'#7B8CDE'});
board.create('text', [-9,-8, function(){var s=0,dx=(B.Value()-A.Value())/N.Value();for(var i=0;i<N.Value();i++){s+=f(A.Value()+i*dx)*dx;}return 'Sum \\u2248 '+s.toFixed(3)+'  (n='+N.Value()+')'}], {fontSize:13});
`
  },
  {
    id: 'c1-chain-rule', course: 'Calc 1', name: 'Chain Rule',
    latex: '\\frac{d}{dx}f(g(x)) = f\'(g(x))\\cdot g\'(x)',
    tags: ['chain rule', 'composition'],
    type: 'jsx',
    code: `
var a = board.create('slider', [[-8,9],[2,9],[0.5,1,3]], {name:'a (outer)', snapWidth:0.1, label:{fontSize:14}});
var b = board.create('slider', [[-8,8],[2,8],[0.5,2,5]], {name:'b (inner)', snapWidth:0.1, label:{fontSize:14}});
var g = function(x){return b.Value()*x;};
var f = function(x){return a.Value()*Math.sin(x);};
var fg = function(x){return f(g(x));};
var dfg = function(x){return a.Value()*Math.cos(b.Value()*x)*b.Value();};
board.create('functiongraph', [fg], {strokeColor:'#7B8CDE', strokeWidth:2});
board.create('functiongraph', [dfg], {strokeColor:'#E06C6C', strokeWidth:2, dash:3});
board.create('text', [-9,7, function(){return 'f(g(x)) = '+a.Value().toFixed(1)+'sin('+b.Value().toFixed(1)+'x)'}], {fontSize:14, color:'#7B8CDE'});
board.create('text', [-9,6, function(){return "d/dx = "+a.Value().toFixed(1)+'\\u00B7'+b.Value().toFixed(1)+'cos('+b.Value().toFixed(1)+'x)'}], {fontSize:14, color:'#E06C6C'});
`
  },

  // ─── CALCULUS 2 ────────────────────────────────────────────
  {
    id: 'c2-taylor', course: 'Calc 2', name: 'Taylor Series (sin x)',
    latex: '\\sin x = \\sum_{k=0}^{n} \\frac{(-1)^k x^{2k+1}}{(2k+1)!}',
    tags: ['taylor', 'series', 'sin', 'approximation'],
    type: 'jsx',
    code: `
var N = board.create('slider', [[-8,9],[2,9],[1,3,12]], {name:'terms', snapWidth:1, label:{fontSize:14}});
function fact(n){var r=1;for(var i=2;i<=n;i++)r*=i;return r;}
function taylorSin(x,n){var s=0;for(var k=0;k<=n;k++){s+=Math.pow(-1,k)*Math.pow(x,2*k+1)/fact(2*k+1);}return s;}
board.create('functiongraph', [Math.sin], {strokeColor:'#7B8CDE', strokeWidth:2, name:'sin(x)'});
board.create('functiongraph', [function(x){return taylorSin(x,N.Value())}], {strokeColor:'#E06C6C', strokeWidth:2, dash:2, name:'Taylor'});
board.create('text', [-9,-8, function(){return 'Taylor polynomial degree '+(2*N.Value()+1)}], {fontSize:13});
`
  },
  {
    id: 'c2-polar', course: 'Calc 2', name: 'Polar Curves (Rose)',
    latex: 'r = a + b\\cos(n\\theta)',
    tags: ['polar', 'rose', 'curve'],
    type: 'jsx',
    code: `
var A = board.create('slider', [[-8,9],[2,9],[0,0,4]], {name:'a', snapWidth:0.1, label:{fontSize:14}});
var B = board.create('slider', [[-8,8],[2,8],[0.5,3,6]], {name:'b', snapWidth:0.1, label:{fontSize:14}});
var N = board.create('slider', [[-8,7],[2,7],[1,3,8]], {name:'n (petals)', snapWidth:1, label:{fontSize:14}});
board.create('curve', [function(t){var r=A.Value()+B.Value()*Math.cos(N.Value()*t);return r*Math.cos(t);},function(t){var r=A.Value()+B.Value()*Math.cos(N.Value()*t);return r*Math.sin(t);},0,2*Math.PI], {strokeColor:'#7B8CDE', strokeWidth:2, curveType:'plot', numberPointsHigh:600});
`
  },
  {
    id: 'c2-series-conv', course: 'Calc 2', name: 'Geometric Series',
    latex: '\\sum_{k=0}^{n} ar^k = a\\frac{1-r^{n+1}}{1-r}',
    tags: ['geometric', 'series', 'convergence'],
    type: 'jsx',
    code: `
var aS = board.create('slider', [[-8,9],[2,9],[0.5,1,3]], {name:'a', snapWidth:0.1, label:{fontSize:14}});
var rS = board.create('slider', [[-8,8],[2,8],[-0.99,0.5,0.99]], {name:'r', snapWidth:0.01, label:{fontSize:14}});
var nS = board.create('slider', [[-8,7],[2,7],[1,10,30]], {name:'n', snapWidth:1, label:{fontSize:14}});
board.create('functiongraph', [function(x){if(x<0||x>nS.Value()||x!==Math.floor(x)) return NaN; var s=0;for(var k=0;k<=x;k++) s+=aS.Value()*Math.pow(rS.Value(),k); return s;}], {strokeColor:'#7B8CDE', strokeWidth:0});
for(var i=0;i<31;i++){(function(k){board.create('point',[function(){return k>nS.Value()?NaN:k},function(){if(k>nS.Value())return NaN;var s=0;for(var j=0;j<=k;j++)s+=aS.Value()*Math.pow(rS.Value(),j);return s;}],{size:2,color:'#7B8CDE',name:'',withLabel:false});})(i);}
board.create('line',[[0,function(){return Math.abs(rS.Value())<1?aS.Value()/(1-rS.Value()):NaN}],[1,function(){return Math.abs(rS.Value())<1?aS.Value()/(1-rS.Value()):NaN}]],{strokeColor:'#5BB98C',dash:3,straightFirst:true,straightLast:true});
board.create('text',[-9,-8,function(){var lim=Math.abs(rS.Value())<1?'Converges to '+(aS.Value()/(1-rS.Value())).toFixed(3):'Diverges!';return lim;}],{fontSize:14});
`
  },

  // ─── CALCULUS 3 / MULTIVARIABLE (Plotly 3D) ───────────────
  {
    id: 'c3-surface', course: 'Multivar Calc', name: '3D Surface Plot',
    latex: 'f(x,y) = \\sin(\\sqrt{x^2+y^2})',
    tags: ['surface', '3d', 'plot'],
    type: 'plotly',
    code: `
var size=40, x=[],y=[],z=[];
for(var i=0;i<size;i++){var xi=-6+12*i/(size-1);x.push(xi);y.push(xi);}
for(var i=0;i<size;i++){var row=[];for(var j=0;j<size;j++){var r=Math.sqrt(x[i]*x[i]+y[j]*y[j]);row.push(Math.sin(r));}z.push(row);}
Plotly.newPlot(container,[{z:z,x:x,y:y,type:'surface',colorscale:'Viridis',contours:{z:{show:true,usecolormap:true,highlightcolor:'#7B8CDE',project:{z:true}}}}],{scene:{xaxis:{title:'x'},yaxis:{title:'y'},zaxis:{title:'f(x,y)'}},paper_bgcolor:'#1F1F1F',plot_bgcolor:'#1F1F1F',font:{color:'#E0E0E0'},margin:{l:0,r:0,t:30,b:0}},{responsive:true});
`
  },
  {
    id: 'c3-contour', course: 'Multivar Calc', name: 'Contour Plot',
    latex: 'f(x,y) = x^2 - y^2',
    tags: ['contour', 'level curve', 'saddle'],
    type: 'plotly',
    code: `
var size=60, x=[],y=[],z=[];
for(var i=0;i<size;i++){x.push(-5+10*i/(size-1));y.push(-5+10*i/(size-1));}
for(var i=0;i<size;i++){var row=[];for(var j=0;j<size;j++){row.push(x[i]*x[i]-y[j]*y[j]);}z.push(row);}
Plotly.newPlot(container,[{z:z,x:x,y:y,type:'contour',colorscale:'RdBu',contours:{coloring:'heatmap',showlabels:true,labelfont:{size:11,color:'white'}},line:{smoothing:0.85}}],{xaxis:{title:'x'},yaxis:{title:'y',scaleanchor:'x'},paper_bgcolor:'#1F1F1F',plot_bgcolor:'#2B2B2B',font:{color:'#E0E0E0'},margin:{l:50,r:20,t:30,b:50}},{responsive:true});
`
  },
  {
    id: 'c3-gradient-field', course: 'Multivar Calc', name: 'Gradient Field',
    latex: '\\nabla f = \\langle f_x, f_y \\rangle',
    tags: ['gradient', 'vector field', 'nabla'],
    type: 'plotly',
    code: `
var x=[],y=[],u=[],v=[];
for(var i=-4;i<=4;i+=0.6){for(var j=-4;j<=4;j+=0.6){x.push(i);y.push(j);u.push(2*i);v.push(2*j);}}
var size=50,cx=[],cy=[],cz=[];
for(var i=0;i<size;i++){cx.push(-5+10*i/(size-1));cy.push(-5+10*i/(size-1));}
for(var i=0;i<size;i++){var row=[];for(var j=0;j<size;j++){row.push(cx[i]*cx[i]+cy[j]*cy[j]);}cz.push(row);}
Plotly.newPlot(container,[{z:cz,x:cx,y:cy,type:'contour',colorscale:'Viridis',opacity:0.5,showscale:false,contours:{showlabels:true,labelfont:{size:10,color:'white'}}},{x:x,y:y,type:'scatter',mode:'markers',marker:{size:2,color:'#E06C6C'}}],{xaxis:{title:'x',range:[-5,5]},yaxis:{title:'y',range:[-5,5],scaleanchor:'x'},annotations:x.map(function(xi,k){return{x:xi,y:y[k],ax:xi+u[k]*0.08,ay:y[k]+v[k]*0.08,xref:'x',yref:'y',axref:'x',ayref:'y',showarrow:true,arrowhead:2,arrowsize:1,arrowwidth:1.5,arrowcolor:'#E06C6C'}}),paper_bgcolor:'#1F1F1F',plot_bgcolor:'#2B2B2B',font:{color:'#E0E0E0'},margin:{l:50,r:20,t:30,b:50},showlegend:false},{responsive:true});
`
  },
  {
    id: 'c3-paraboloid', course: 'Multivar Calc', name: 'Paraboloid + Contours',
    latex: 'f(x,y) = x^2 + y^2',
    tags: ['paraboloid', 'surface', 'contour', 'minimum'],
    type: 'plotly',
    code: `
var size=50,x=[],y=[],z=[];
for(var i=0;i<size;i++){x.push(-4+8*i/(size-1));y.push(-4+8*i/(size-1));}
for(var i=0;i<size;i++){var row=[];for(var j=0;j<size;j++){row.push(x[i]*x[i]+y[j]*y[j]);}z.push(row);}
Plotly.newPlot(container,[{z:z,x:x,y:y,type:'surface',colorscale:'Viridis',contours:{z:{show:true,usecolormap:true,project:{z:true}},x:{show:true,color:'#7B8CDE',width:1},y:{show:true,color:'#5BB98C',width:1}}}],{scene:{xaxis:{title:'x'},yaxis:{title:'y'},zaxis:{title:'z'},camera:{eye:{x:1.5,y:1.5,z:1}}},paper_bgcolor:'#1F1F1F',font:{color:'#E0E0E0'},margin:{l:0,r:0,t:30,b:0}},{responsive:true});
`
  },
  {
    id: 'c3-partial-deriv', course: 'Multivar Calc', name: 'Partial Derivatives',
    latex: 'f_x = \\frac{\\partial f}{\\partial x},\\; f_y = \\frac{\\partial f}{\\partial y}',
    tags: ['partial derivative', 'tangent plane'],
    type: 'jsx',
    code: `
var x0 = board.create('slider', [[-8,9],[2,9],[-4,1,4]], {name:'x\\u2080', snapWidth:0.1, label:{fontSize:14}});
var y0 = board.create('slider', [[-8,8],[2,8],[-4,1,4]], {name:'y\\u2080', snapWidth:0.1, label:{fontSize:14}});
var f = function(x,y){return Math.sin(x)*Math.cos(y);};
var fx = function(x,y){return Math.cos(x)*Math.cos(y);};
var fy = function(x,y){return -Math.sin(x)*Math.sin(y);};
board.create('functiongraph', [function(x){return f(x, y0.Value())}], {strokeColor:'#7B8CDE', strokeWidth:2});
board.create('functiongraph', [function(y){return f(x0.Value(), y)}], {strokeColor:'#5BB98C', strokeWidth:2, dash:3});
board.create('point', [function(){return x0.Value()}, function(){return f(x0.Value(), y0.Value())}], {name:'P', color:'#E06C6C', size:4});
board.create('text', [-9,-7, function(){return '\\u2202f/\\u2202x = '+fx(x0.Value(),y0.Value()).toFixed(3)}], {fontSize:14, color:'#7B8CDE'});
board.create('text', [-9,-8.5, function(){return '\\u2202f/\\u2202y = '+fy(x0.Value(),y0.Value()).toFixed(3)}], {fontSize:14, color:'#5BB98C'});
`
  },

  // ─── PHYSICS ───────────────────────────────────────────────
  {
    id: 'ph-projectile', course: 'Physics', name: 'Projectile Motion',
    latex: 'y = v_0 t\\sin\\theta - \\tfrac{1}{2}gt^2',
    tags: ['projectile', 'kinematics', 'trajectory', 'motion'],
    type: 'jsx',
    code: `
var v0 = board.create('slider', [[-8,9],[2,9],[5,20,40]], {name:'v\\u2080 (m/s)', snapWidth:0.5, label:{fontSize:13}});
var ang = board.create('slider', [[-8,8],[2,8],[10,45,80]], {name:'\\u03B8 (deg)', snapWidth:1, label:{fontSize:13}});
var g=9.81;
board.create('curve',[function(t){return v0.Value()*Math.cos(ang.Value()*Math.PI/180)*t;},function(t){var th=ang.Value()*Math.PI/180;return v0.Value()*Math.sin(th)*t-0.5*g*t*t;},0,function(){return 2*v0.Value()*Math.sin(ang.Value()*Math.PI/180)/g;}],{strokeColor:'#E06C6C',strokeWidth:2,curveType:'plot',numberPointsHigh:300});
board.create('text',[-9,-8,function(){var th=ang.Value()*Math.PI/180;return 'Range='+( v0.Value()*v0.Value()*Math.sin(2*th)/g).toFixed(1)+'m  Max H='+(v0.Value()*v0.Value()*Math.pow(Math.sin(th),2)/(2*g)).toFixed(1)+'m'}],{fontSize:13});
`
  },
  {
    id: 'ph-shm', course: 'Physics', name: 'Simple Harmonic Motion',
    latex: 'x(t)=A\\cos(\\omega t+\\phi)',
    tags: ['SHM', 'oscillation', 'spring', 'harmonic'],
    type: 'jsx',
    code: `
var A = board.create('slider', [[-8,9],[2,9],[0.5,3,8]], {name:'A (amplitude)', snapWidth:0.1, label:{fontSize:13}});
var w = board.create('slider', [[-8,8],[2,8],[0.5,2,6]], {name:'\\u03C9 (rad/s)', snapWidth:0.1, label:{fontSize:13}});
var phi = board.create('slider', [[-8,7],[2,7],[0,0,6.28]], {name:'\\u03C6 (phase)', snapWidth:0.05, label:{fontSize:13}});
board.create('functiongraph', [function(t){return A.Value()*Math.cos(w.Value()*t+phi.Value())}], {strokeColor:'#7B8CDE', strokeWidth:2, name:'x(t)'});
board.create('functiongraph', [function(t){return -A.Value()*w.Value()*Math.sin(w.Value()*t+phi.Value())}], {strokeColor:'#E06C6C', strokeWidth:1.5, dash:3, name:'v(t)'});
board.create('text',[-9,-8,function(){return 'T = '+(2*Math.PI/w.Value()).toFixed(2)+'s  f = '+(w.Value()/(2*Math.PI)).toFixed(2)+'Hz'}],{fontSize:13});
`
  },
  {
    id: 'ph-wave', course: 'Physics', name: 'Traveling Wave',
    latex: 'y(x,t)=A\\sin(kx-\\omega t)',
    tags: ['wave', 'wavelength', 'frequency', 'traveling'],
    type: 'jsx',
    code: `
var A = board.create('slider', [[-8,9],[2,9],[0.5,3,6]], {name:'A', snapWidth:0.1, label:{fontSize:13}});
var k = board.create('slider', [[-8,8],[2,8],[0.3,1,4]], {name:'k (wavenumber)', snapWidth:0.1, label:{fontSize:13}});
var w = board.create('slider', [[-8,7],[2,7],[0,2,6]], {name:'\\u03C9', snapWidth:0.1, label:{fontSize:13}});
var t = board.create('slider', [[-8,6],[2,6],[0,0,10]], {name:'t (time)', snapWidth:0.05, label:{fontSize:13}});
board.create('functiongraph', [function(x){return A.Value()*Math.sin(k.Value()*x - w.Value()*t.Value())}], {strokeColor:'#7B8CDE', strokeWidth:2});
board.create('text',[-9,-8,function(){return '\\u03BB='+(2*Math.PI/k.Value()).toFixed(2)+'  v='+(w.Value()/k.Value()).toFixed(2)+'  f='+(w.Value()/(2*Math.PI)).toFixed(2)+'Hz'}],{fontSize:13});
`
  },
  {
    id: 'ph-coulomb', course: 'Physics', name: "Coulomb's Law (Force vs r)",
    latex: 'F = k_e \\frac{q_1 q_2}{r^2}',
    tags: ['coulomb', 'electric', 'force', 'charge'],
    type: 'jsx',
    code: `
var q1 = board.create('slider', [[-8,9],[2,9],[0.5,1,5]], {name:'q\\u2081 (\\u03BCC)', snapWidth:0.1, label:{fontSize:13}});
var q2 = board.create('slider', [[-8,8],[2,8],[0.5,1,5]], {name:'q\\u2082 (\\u03BCC)', snapWidth:0.1, label:{fontSize:13}});
var ke = 8.99;
board.create('functiongraph', [function(r){if(r<0.2)return NaN;return ke*q1.Value()*q2.Value()/(r*r);}], {strokeColor:'#E06C6C', strokeWidth:2});
board.create('text',[-9,-8,function(){return 'F(1m) = '+(ke*q1.Value()*q2.Value()).toFixed(2)+' N'}],{fontSize:13});
board.setAttribute({boundingbox:[-1,50,8,-5]});
`
  },
  {
    id: 'ph-pendulum', course: 'Physics', name: 'Pendulum',
    latex: '\\theta(t) = \\theta_0\\cos\\!\\left(\\!\\sqrt{\\frac{g}{L}}\\,t\\right)',
    tags: ['pendulum', 'gravity', 'oscillation'],
    type: 'jsx',
    code: `
var th0 = board.create('slider', [[-8,9],[2,9],[0.1,0.5,1.4]], {name:'\\u03B8\\u2080 (rad)', snapWidth:0.01, label:{fontSize:13}});
var L = board.create('slider', [[-8,8],[2,8],[0.5,2,8]], {name:'L (m)', snapWidth:0.1, label:{fontSize:13}});
var g=9.81;
board.create('functiongraph', [function(t){return th0.Value()*Math.cos(Math.sqrt(g/L.Value())*t)}], {strokeColor:'#7B8CDE', strokeWidth:2, name:'\\u03B8(t)'});
board.create('text',[-9,-8,function(){return 'Period T = '+(2*Math.PI*Math.sqrt(L.Value()/g)).toFixed(3)+'s  f = '+(1/(2*Math.PI*Math.sqrt(L.Value()/g))).toFixed(3)+'Hz'}],{fontSize:13});
`
  },
];

// Index by ID
const MATH_PRESET_MAP = {};
MATH_PRESETS.forEach(p => MATH_PRESET_MAP[p.id] = p);

// Group by course
const MATH_COURSES = {};
MATH_PRESETS.forEach(p => {
  if (!MATH_COURSES[p.course]) MATH_COURSES[p.course] = [];
  MATH_COURSES[p.course].push(p);
});
