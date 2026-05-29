const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin'); // For generating the HTML file

module.exports = {
    entry: {
        app: path.join(__dirname, 'src', 'index.js'),  // The entry point of your application
    },
    output: {
        filename: 'bundle.js',  // Output file name after bundling
        path: path.resolve(__dirname, 'dist'),  // Directory for bundled output
    },
    module: {
        rules: [
        {
            test: /\.js$/,  // Apply Babel loader to all .js files
            exclude: /node_modules/,  // Don't process files in node_modules
            use: {
            loader: 'babel-loader',  // Use babel-loader to transpile JavaScript
            options: {
                presets: ['@babel/preset-env'],  // Use Babel preset to handle modern JavaScript
                sourceType: 'module',  // Ensure files are treated as ES modules
            },
            },
        },
        // Add GLSL loader for shader files
        {
            test: /\.glsl$/,
            use: 'webpack-glsl-loader',
        },
        {
            test: /\.html$/,  // Match .html files
            use: 'html-loader',  // Use html-loader for .html files
        },
        ],
    },
    resolve: {
        extensions: ['.js', '.html'],  // Resolve only JavaScript files
    },
    devServer: {
        static: {
        directory: path.join(__dirname, 'dist'),  // Serve static files from 'dist'
        },
        compress: true,       // Enable gzip compression
        port: 8080,           // The port to run the server on
        host: '0.0.0.0',      // Listen on all interfaces so Meta Quest 2 can connect via LAN IP
        allowedHosts: 'all',  // Allow any host header (needed for Quest 2 browser access)
        open: true,           // Automatically open the browser
        hot: true,            // Enable Hot Module Replacement
        // Headers required for SharedArrayBuffer (used by some WebXR polyfills)
        headers: {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
    plugins: [
        new HtmlWebpackPlugin({
        template: './src/index.html',  // Path to your HTML template
        }),
    ],
    mode: 'development',  // Set the mode to development
};
